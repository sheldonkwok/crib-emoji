import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CribError,
  MAX_EMOJI_BYTES,
  createGuildEmoji,
  downloadEmoji,
  editOriginalResponse,
  type FetchFn,
} from '../lib/discord.js';

const ID = '123456789012345678';
const TOKEN = 'super.secret.bot-token';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fake fetch that records calls and answers from a responder. Never touches the network. */
function fakeFetch(responder: Responder): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchFn: fn as FetchFn, calls };
}

function image(bytes: Uint8Array<ArrayBuffer>, type = 'image/png', status = 200): Response {
  return new Response(bytes, { status, headers: { 'content-type': type } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('downloadEmoji', () => {
  it('downloads a static emoji as a png data URI', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { fetchFn, calls } = fakeFetch(() => image(bytes, 'image/png'));
    const { dataUri } = await downloadEmoji({ id: ID, animated: false }, fetchFn);
    assert.equal(dataUri, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    assert.deepEqual(
      calls.map((c) => c.url),
      [`https://cdn.discordapp.com/emojis/${ID}.png?size=128`],
    );
  });

  it('strips content-type parameters', async () => {
    const { fetchFn } = fakeFetch(() => image(new Uint8Array([1, 2]), 'Image/GIF; charset=binary'));
    const { dataUri } = await downloadEmoji({ id: ID, animated: true }, fetchFn);
    assert.equal(dataUri, 'data:image/gif;base64,AQI=');
  });

  it('uses the gif when available for animated emojis', async () => {
    const { fetchFn, calls } = fakeFetch(() => image(new Uint8Array([7]), 'image/gif'));
    const { dataUri } = await downloadEmoji({ id: ID, animated: true }, fetchFn);
    assert.ok(dataUri.startsWith('data:image/gif;base64,'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `https://cdn.discordapp.com/emojis/${ID}.gif`);
  });

  it('falls back from gif to animated webp', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('.gif')
        ? new Response('not found', { status: 415, headers: { 'content-type': 'text/plain' } })
        : image(new Uint8Array([9, 9]), 'image/webp'),
    );
    const { dataUri } = await downloadEmoji({ id: ID, animated: true }, fetchFn);
    assert.equal(dataUri, 'data:image/webp;base64,CQk=');
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        `https://cdn.discordapp.com/emojis/${ID}.gif`,
        `https://cdn.discordapp.com/emojis/${ID}.webp?animated=true&size=128`,
      ],
    );
  });

  it('falls back when the first candidate throws a network error', async () => {
    const { fetchFn } = fakeFetch((url) => {
      if (url.includes('.gif')) throw new TypeError('fetch failed');
      return image(new Uint8Array([1]), 'image/webp');
    });
    const { dataUri } = await downloadEmoji({ id: ID, animated: true }, fetchFn);
    assert.ok(dataUri.startsWith('data:image/webp;base64,'));
  });

  it('throws a CribError when every candidate fails', async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response('nope', { status: 404 }));
    await assert.rejects(downloadEmoji({ id: ID, animated: true }, fetchFn), (err) => {
      assert.ok(err instanceof CribError);
      assert.match(err.message, /couldn't download/i);
      assert.match(err.message, /deleted/i);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it('skips ok responses that are not images', async () => {
    const { fetchFn } = fakeFetch(() =>
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await assert.rejects(
      downloadEmoji({ id: ID, animated: false }, fetchFn),
      (err) => err instanceof CribError && /deleted/i.test(err.message),
    );
  });

  it('skips responses with no content type', async () => {
    const { fetchFn } = fakeFetch(() => {
      const res = new Response(new Uint8Array([1]), { status: 200 });
      res.headers.delete('content-type');
      return res;
    });
    await assert.rejects(downloadEmoji({ id: ID, animated: false }, fetchFn), CribError);
  });

  it('throws a too-large CribError when the image exceeds 256 KB', async () => {
    const big = new Uint8Array(MAX_EMOJI_BYTES + 1);
    const { fetchFn } = fakeFetch(() => image(big, 'image/png'));
    await assert.rejects(downloadEmoji({ id: ID, animated: false }, fetchFn), (err) => {
      assert.ok(err instanceof CribError);
      assert.match(err.message, /too large/i);
      assert.match(err.message, /256 KB/);
      return true;
    });
  });

  it('accepts an image of exactly 256 KB', async () => {
    const { fetchFn } = fakeFetch(() => image(new Uint8Array(MAX_EMOJI_BYTES), 'image/png'));
    const { dataUri } = await downloadEmoji({ id: ID, animated: false }, fetchFn);
    assert.ok(dataUri.startsWith('data:image/png;base64,'));
  });

  it('tries the smaller webp when the gif is too large', async () => {
    const { fetchFn } = fakeFetch((url) =>
      url.includes('.gif')
        ? image(new Uint8Array(MAX_EMOJI_BYTES + 10), 'image/gif')
        : image(new Uint8Array([5]), 'image/webp'),
    );
    const { dataUri } = await downloadEmoji({ id: ID, animated: true }, fetchFn);
    assert.equal(dataUri, 'data:image/webp;base64,BQ==');
  });

  it('reports too large when all animated candidates are too large', async () => {
    const { fetchFn } = fakeFetch(() => image(new Uint8Array(MAX_EMOJI_BYTES + 1), 'image/gif'));
    await assert.rejects(
      downloadEmoji({ id: ID, animated: true }, fetchFn),
      (err) => err instanceof CribError && /too large/i.test(err.message),
    );
  });
});

describe('createGuildEmoji', () => {
  const args = {
    guildId: '987654321098765432',
    name: 'blob_cat',
    dataUri: 'data:image/png;base64,AAAA',
    botToken: TOKEN,
  };

  it('sends the right request and returns the created emoji', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({ id: '111111111111111111', name: 'blob_cat', animated: true, roles: [] }, 201),
    );
    const result = await createGuildEmoji({ ...args, reason: 'Cribbed by user#1 (ünïcode)' }, fetchFn);
    assert.deepEqual(result, { id: '111111111111111111', name: 'blob_cat', animated: true });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'https://discord.com/api/v10/guilds/987654321098765432/emojis');
    assert.equal(call.init?.method, 'POST');
    const headers = headersOf(call.init);
    assert.equal(headers.get('authorization'), `Bot ${TOKEN}`);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(
      headers.get('x-audit-log-reason'),
      encodeURIComponent('Cribbed by user#1 (ünïcode)'),
    );
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      name: 'blob_cat',
      image: 'data:image/png;base64,AAAA',
    });
  });

  it('omits the audit log reason header when no reason is given', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ id: '1', name: 'blob_cat' }, 201));
    await createGuildEmoji(args, fetchFn);
    assert.equal(headersOf(calls[0]?.init).has('x-audit-log-reason'), false);
  });

  it('defaults animated to false when missing', async () => {
    const { fetchFn } = fakeFetch(() => json({ id: '222', name: 'blob_cat' }, 201));
    const result = await createGuildEmoji(args, fetchFn);
    assert.deepEqual(result, { id: '222', name: 'blob_cat', animated: false });
  });

  async function errorFor(res: () => Response): Promise<CribError> {
    const { fetchFn } = fakeFetch(res);
    try {
      await createGuildEmoji(args, fetchFn);
    } catch (err) {
      assert.ok(err instanceof CribError, `expected CribError, got ${String(err)}`);
      assert.ok(!err.message.includes(TOKEN), 'error message must not include the bot token');
      return err;
    }
    assert.fail('expected createGuildEmoji to throw');
  }

  it('maps 30008 to no emoji slots', async () => {
    const err = await errorFor(() =>
      json({ code: 30008, message: 'Maximum number of emojis reached (50)' }, 400),
    );
    assert.match(err.message, /no emoji slots/i);
  });

  it('maps 30018 to no animated emoji slots', async () => {
    const err = await errorFor(() =>
      json({ code: 30018, message: 'Maximum number of animated emojis reached (50)' }, 400),
    );
    assert.match(err.message, /no animated emoji slots/i);
  });

  it('maps 50013 to missing Create Expressions permission', async () => {
    const err = await errorFor(() => json({ code: 50013, message: 'Missing Permissions' }, 403));
    assert.match(err.message, /Create Expressions/);
  });

  it('maps a bare HTTP 403 to missing Create Expressions permission', async () => {
    const err = await errorFor(() => new Response('Forbidden', { status: 403 }));
    assert.match(err.message, /Create Expressions/);
  });

  it('maps 50001 to bot not in server / missing access', async () => {
    const err = await errorFor(() => json({ code: 50001, message: 'Missing Access' }, 403));
    assert.match(err.message, /access/i);
    assert.match(err.message, /added/i);
    assert.doesNotMatch(err.message, /Create Expressions/);
  });

  it('maps 50035 to invalid form body with Discord detail', async () => {
    const err = await errorFor(() =>
      json(
        {
          code: 50035,
          message: 'Invalid Form Body',
          errors: {
            name: {
              _errors: [
                { code: 'BASE_TYPE_BAD_LENGTH', message: 'Must be between 2 and 32 in length.' },
              ],
            },
          },
        },
        400,
      ),
    );
    assert.match(err.message, /rejected the emoji name or image/i);
    assert.match(err.message, /name: Must be between 2 and 32 in length\./);
  });

  it('maps 50035 without details', async () => {
    const err = await errorFor(() => json({ code: 50035, message: 'Invalid Form Body' }, 400));
    assert.match(err.message, /rejected the emoji name or image/i);
  });

  it('maps 50138 to image too big', async () => {
    const err = await errorFor(() =>
      json({ code: 50138, message: 'Failed to resize asset below the maximum size: 262144' }, 400),
    );
    assert.match(err.message, /too big/i);
    assert.match(err.message, /256 KB/);
  });

  it('maps a 50035 size error on the image field to image too big', async () => {
    const err = await errorFor(() =>
      json(
        {
          code: 50035,
          message: 'Invalid Form Body',
          errors: {
            image: {
              _errors: [
                { code: 'BINARY_TYPE_MAX_SIZE', message: 'File cannot be larger than 256.0 kb.' },
              ],
            },
          },
        },
        400,
      ),
    );
    assert.match(err.message, /too big/i);
  });

  it('maps HTTP 413 to image too big', async () => {
    const err = await errorFor(() => new Response('Request Entity Too Large', { status: 413 }));
    assert.match(err.message, /too big/i);
  });

  it('maps HTTP 429 to rate limited', async () => {
    const err = await errorFor(() =>
      json({ message: 'You are being rate limited.', retry_after: 2.5, global: false }, 429),
    );
    assert.match(err.message, /rate limit/i);
    assert.match(err.message, /3 seconds/);
  });

  it('maps HTTP 429 without a JSON body to rate limited', async () => {
    const err = await errorFor(() => new Response('', { status: 429 }));
    assert.match(err.message, /rate limit/i);
    assert.match(err.message, /try again/i);
  });

  it('falls back to a generic error with status and message', async () => {
    const err = await errorFor(() => json({ code: 0, message: '500: Internal Server Error' }, 500));
    assert.match(err.message, /HTTP 500/);
    assert.match(err.message, /Internal Server Error/);
  });

  it('handles a non-JSON error body', async () => {
    const err = await errorFor(() => new Response('<html>bad gateway</html>', { status: 502 }));
    assert.match(err.message, /HTTP 502/);
  });

  it('wraps network errors in a CribError without leaking the token', async () => {
    const err = await errorFor(() => {
      throw new TypeError(`fetch failed for Bot ${TOKEN}`);
    });
    assert.match(err.message, /couldn't reach discord/i);
  });
});

describe('editOriginalResponse', () => {
  const args = {
    applicationId: '555555555555555555',
    interactionToken: 'aW50ZXJhY3Rpb24-token_xyz',
    content: 'Added <:blob:1> @everyone',
  };

  it('sends a PATCH to the original response webhook', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ id: '1' }, 200));
    await editOriginalResponse(args, fetchFn);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(
      call.url,
      'https://discord.com/api/v10/webhooks/555555555555555555/aW50ZXJhY3Rpb24-token_xyz/messages/@original',
    );
    assert.equal(call.init?.method, 'PATCH');
    assert.equal(headersOf(call.init).get('content-type'), 'application/json');
    assert.equal(headersOf(call.init).has('authorization'), false);
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      content: 'Added <:blob:1> @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('throws a plain Error (not CribError) when the response is not ok', async () => {
    const { fetchFn } = fakeFetch(() => json({ code: 10015, message: 'Unknown Webhook' }, 404));
    await assert.rejects(editOriginalResponse(args, fetchFn), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof CribError));
      assert.match(err.message, /404/);
      assert.ok(!err.message.includes(args.interactionToken));
      return true;
    });
  });
});
