import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { handleInteraction } from '../lib/handler.js';
import type { Deps, Env } from '../lib/handler.js';

// --- Signing helpers -------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
assert.ok(jwk.x, 'expected an x value in the ed25519 JWK');
const PUBLIC_KEY_HEX = Buffer.from(jwk.x, 'base64url').toString('hex');
assert.equal(PUBLIC_KEY_HEX.length, 64);

const BOT_TOKEN = 'test-bot-token-SECRET';
const ENV: Env = { publicKey: PUBLIC_KEY_HEX, botToken: BOT_TOKEN };

const APP_ID = '111111111111111111';
const INTERACTION_TOKEN = 'interaction-token-abc';
const GUILD_ID = '222222222222222222';
const USER_ID = '333333333333333333';
const STATIC_EMOJI_ID = '123456789012345678';
const ANIMATED_EMOJI_ID = '876543210987654321';
const NEW_EMOJI_ID = '999999999999999999';

function signBody(body: string, timestamp: string): string {
  return sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
}

function makeRequest(
  body: string,
  opts: { signature?: string | null; timestamp?: string | null; sendBody?: string } = {},
): Request {
  const timestamp = opts.timestamp === undefined ? String(Math.floor(Date.now() / 1000)) : opts.timestamp;
  const signature =
    opts.signature === undefined ? (timestamp === null ? null : signBody(body, timestamp)) : opts.signature;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (signature !== null) headers.set('X-Signature-Ed25519', signature);
  if (timestamp !== null) headers.set('X-Signature-Timestamp', timestamp);
  return new Request('https://example.vercel.app/api/interactions', {
    method: 'POST',
    headers,
    body: opts.sendBody ?? body,
  });
}

function signedRequest(payload: unknown): Request {
  return makeRequest(JSON.stringify(payload));
}

// --- Fakes -----------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Route = (call: RecordedCall) => Response | undefined;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);

function cdnRoute(call: RecordedCall): Response | undefined {
  const url = new URL(call.url);
  if (url.hostname !== 'cdn.discordapp.com' && url.hostname !== 'media.discordapp.net') return undefined;
  if (/\.gif$/i.test(url.pathname)) {
    return new Response(GIF_BYTES, { status: 200, headers: { 'Content-Type': 'image/gif' } });
  }
  if (/\.webp$/i.test(url.pathname)) {
    return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/webp' } });
  }
  return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

function createEmojiRoute(result: { status: number; body: unknown }): Route {
  return (call) => {
    if (call.method === 'POST' && new URL(call.url).pathname.endsWith(`/guilds/${GUILD_ID}/emojis`)) {
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return undefined;
  };
}

function editOriginalRoute(call: RecordedCall): Response | undefined {
  if (call.method === 'PATCH' && call.url.includes('/messages/@original')) {
    return new Response(JSON.stringify({ id: '1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return undefined;
}

function makeDeps(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const pending: Promise<unknown>[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = req.body ? await req.text() : undefined;
    const call: RecordedCall = { url: req.url, method: req.method.toUpperCase(), headers: req.headers, body };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    return new Response(JSON.stringify({ message: '404: Not Found', code: 0 }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const deps: Deps = {
    fetch: fakeFetch,
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };

  return {
    deps,
    calls,
    pending,
    /** Awaits every background promise; fails the test if any rejects. */
    async settle(): Promise<void> {
      const results = await Promise.allSettled(pending);
      for (const r of results) {
        assert.equal(r.status, 'fulfilled', 'background promise must never reject');
      }
    },
  };
}

function commandPayload(opts: {
  name?: string;
  link?: string;
  guild?: boolean;
  commandName?: string;
  options?: unknown;
}) {
  const options =
    opts.options !== undefined
      ? opts.options
      : [
          { name: 'name', type: 3, value: opts.name ?? 'party_parrot' },
          { name: 'link', type: 3, value: opts.link ?? `https://cdn.discordapp.com/emojis/${STATIC_EMOJI_ID}.png` },
        ];
  const base: Record<string, unknown> = {
    id: '444444444444444444',
    type: 2,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    data: { id: '555555555555555555', name: opts.commandName ?? 'crib-emoji', type: 1, options },
  };
  if (opts.guild === false) {
    base.user = { id: USER_ID, username: 'cribber' };
  } else {
    base.guild_id = GUILD_ID;
    base.member = { user: { id: USER_ID, username: 'cribber' }, permissions: '0' };
  }
  return base;
}

async function readJson(res: Response): Promise<any> {
  assert.match(res.headers.get('Content-Type') ?? '', /application\/json/);
  return res.json();
}

function patchCall(calls: RecordedCall[]): RecordedCall {
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'expected a PATCH to edit the original response');
  assert.equal(
    new URL(patch.url).pathname.replace(/^\/api(\/v\d+)?/, ''),
    `/webhooks/${APP_ID}/${INTERACTION_TOKEN}/messages/@original`,
  );
  return patch;
}

function patchContent(calls: RecordedCall[]): string {
  const patch = patchCall(calls);
  assert.ok(patch.body, 'PATCH should have a body');
  const parsed = JSON.parse(patch.body) as { content?: unknown };
  assert.equal(typeof parsed.content, 'string');
  return parsed.content as string;
}

// --- Signature verification -----------------------------------------------

test('missing signature headers -> 401', async () => {
  const { deps, calls } = makeDeps([]);
  const body = JSON.stringify({ type: 1 });

  const noSig = await handleInteraction(makeRequest(body, { signature: null }), ENV, deps);
  assert.equal(noSig.status, 401);

  const noTs = await handleInteraction(makeRequest(body, { timestamp: null, signature: 'ab'.repeat(64) }), ENV, deps);
  assert.equal(noTs.status, 401);

  const neither = await handleInteraction(makeRequest(body, { timestamp: null, signature: null }), ENV, deps);
  assert.equal(neither.status, 401);

  assert.equal(calls.length, 0);
});

test('wrong signature -> 401', async () => {
  const { deps } = makeDeps([]);
  const body = JSON.stringify({ type: 1 });
  // Signed by a different key.
  const other = generateKeyPairSync('ed25519').privateKey;
  const ts = String(Math.floor(Date.now() / 1000));
  const badSig = sign(null, Buffer.from(ts + body), other).toString('hex');
  const res = await handleInteraction(makeRequest(body, { timestamp: ts, signature: badSig }), ENV, deps);
  assert.equal(res.status, 401);

  const garbage = await handleInteraction(makeRequest(body, { signature: 'not-hex' }), ENV, deps);
  assert.equal(garbage.status, 401);
});

test('tampered body -> 401', async () => {
  const { deps, pending, calls } = makeDeps([]);
  const original = JSON.stringify(commandPayload({ guild: false }));
  const tampered = JSON.stringify(commandPayload({}));
  const res = await handleInteraction(makeRequest(original, { sendBody: tampered }), ENV, deps);
  assert.equal(res.status, 401);
  assert.equal(pending.length, 0);
  assert.equal(calls.length, 0);
});

// --- Basic interactions ----------------------------------------------------

test('PING -> PONG', async () => {
  const { deps } = makeDeps([]);
  const res = await handleInteraction(signedRequest({ type: 1, id: '1', application_id: APP_ID }), ENV, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { type: 1 });
});

test('unknown command -> 400', async () => {
  const { deps, pending } = makeDeps([]);
  const res = await handleInteraction(signedRequest(commandPayload({ commandName: 'something-else' })), ENV, deps);
  assert.equal(res.status, 400);
  await readJson(res);
  assert.equal(pending.length, 0);
});

test('unknown interaction type -> 400', async () => {
  const { deps } = makeDeps([]);
  const res = await handleInteraction(signedRequest({ type: 3, id: '1', application_id: APP_ID }), ENV, deps);
  assert.equal(res.status, 400);
  await readJson(res);
});

// --- Validation replies ----------------------------------------------------

test('no guild -> ephemeral error', async () => {
  const { deps, calls, pending } = makeDeps([]);
  const res = await handleInteraction(signedRequest(commandPayload({ guild: false })), ENV, deps);
  assert.equal(res.status, 200);
  const json = await readJson(res);
  assert.equal(json.type, 4);
  assert.equal(json.data.flags, 64);
  assert.match(json.data.content, /server/i);
  assert.equal(calls.length, 0);
  assert.equal(pending.length, 0);
});

test('invalid name -> ephemeral explanation', async () => {
  for (const name of ['a', 'has space', 'x'.repeat(33), 'emoji!']) {
    const { deps, calls, pending } = makeDeps([]);
    const res = await handleInteraction(signedRequest(commandPayload({ name })), ENV, deps);
    const json = await readJson(res);
    assert.equal(json.type, 4);
    assert.equal(json.data.flags, 64);
    assert.match(json.data.content, /2-32/);
    assert.match(json.data.content, /underscore/i);
    assert.equal(calls.length, 0);
    assert.equal(pending.length, 0);
  }
});

test('invalid link -> ephemeral explanation and no fetch', async () => {
  for (const link of [
    `https://evil.com/emojis/${STATIC_EMOJI_ID}.png`,
    'not a link',
    `http://cdn.discordapp.com/emojis/${STATIC_EMOJI_ID}.png`,
  ]) {
    const { deps, calls, pending } = makeDeps([cdnRoute]);
    const res = await handleInteraction(signedRequest(commandPayload({ link })), ENV, deps);
    const json = await readJson(res);
    assert.equal(json.type, 4);
    assert.equal(json.data.flags, 64);
    assert.match(json.data.content, /Copy Link/);
    assert.match(json.data.content, /https:\/\/cdn\.discordapp\.com\/emojis\//);
    assert.equal(calls.length, 0);
    assert.equal(pending.length, 0);
  }
});

test('missing options are handled defensively', async () => {
  const { deps, calls } = makeDeps([]);
  for (const options of [undefined, null, [], [{ name: 'name' }], 'nonsense']) {
    const payload = commandPayload({});
    (payload.data as Record<string, unknown>).options = options;
    const res = await handleInteraction(signedRequest(payload), ENV, deps);
    assert.equal(res.status, 200);
    const json = await readJson(res);
    assert.equal(json.type, 4);
    assert.equal(json.data.flags, 64);
  }
  assert.equal(calls.length, 0);
});

// --- Happy paths -----------------------------------------------------------

test('happy path (static): defers, downloads, creates, edits original', async () => {
  const { deps, calls, pending, settle } = makeDeps([
    cdnRoute,
    createEmojiRoute({ status: 201, body: { id: NEW_EMOJI_ID, name: 'party_parrot', animated: false } }),
    editOriginalRoute,
  ]);
  const res = await handleInteraction(
    signedRequest(commandPayload({ name: 'party_parrot', link: `https://cdn.discordapp.com/emojis/${STATIC_EMOJI_ID}.webp?size=48` })),
    ENV,
    deps,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { type: 5 });
  assert.equal(pending.length, 1);

  await settle();

  const cdnCalls = calls.filter((c) => new URL(c.url).hostname === 'cdn.discordapp.com');
  assert.ok(cdnCalls.length >= 1, 'expected a CDN download');
  for (const c of cdnCalls) {
    assert.equal(c.method, 'GET');
    assert.ok(c.url.includes(`/emojis/${STATIC_EMOJI_ID}`));
    assert.equal(c.headers.get('Authorization'), null, 'bot token must not be sent to the CDN');
  }

  const createIdx = calls.findIndex((c) => c.method === 'POST');
  assert.ok(createIdx > calls.indexOf(cdnCalls[0]!), 'create happens after the download');
  const create = calls[createIdx]!;
  assert.equal(new URL(create.url).hostname, 'discord.com');
  assert.ok(new URL(create.url).pathname.endsWith(`/guilds/${GUILD_ID}/emojis`));
  assert.equal(create.headers.get('Authorization'), `Bot ${BOT_TOKEN}`);
  const createBody = JSON.parse(create.body ?? '{}') as { name?: string; image?: string };
  assert.equal(createBody.name, 'party_parrot');
  assert.match(createBody.image ?? '', /^data:image\/[a-z]+;base64,/);
  const reasonHeader = create.headers.get('X-Audit-Log-Reason');
  if (reasonHeader !== null) {
    assert.match(decodeURIComponent(reasonHeader), new RegExp(`cribber \\(${USER_ID}\\)`));
  }

  const patchIdx = calls.findIndex((c) => c.method === 'PATCH');
  assert.ok(patchIdx > createIdx, 'edit happens after create');
  const content = patchContent(calls);
  assert.ok(content.includes(`<:party_parrot:${NEW_EMOJI_ID}>`), content);
  assert.ok(content.includes('`:party_parrot:`'), content);
  assert.ok(!content.includes(BOT_TOKEN));
});

test('happy path (animated): renders <a:name:id>', async () => {
  const { deps, calls, settle } = makeDeps([
    cdnRoute,
    createEmojiRoute({ status: 201, body: { id: NEW_EMOJI_ID, name: 'dance', animated: true } }),
    editOriginalRoute,
  ]);
  const res = await handleInteraction(
    signedRequest(commandPayload({ name: 'dance', link: `https://cdn.discordapp.com/emojis/${ANIMATED_EMOJI_ID}.gif?size=48` })),
    ENV,
    deps,
  );
  assert.deepEqual(await readJson(res), { type: 5 });
  await settle();

  const cdnCalls = calls.filter((c) => new URL(c.url).hostname === 'cdn.discordapp.com');
  assert.ok(cdnCalls.length >= 1);
  assert.ok(cdnCalls.every((c) => c.url.includes(`/emojis/${ANIMATED_EMOJI_ID}`)));

  const create = calls.find((c) => c.method === 'POST');
  assert.ok(create);
  assert.match(JSON.parse(create.body ?? '{}').image ?? '', /^data:image\/gif;base64,/);

  const content = patchContent(calls);
  assert.ok(content.includes(`<a:dance:${NEW_EMOJI_ID}>`), content);
});

// --- Failure paths ---------------------------------------------------------

test('Discord error on create (30008) -> friendly failure in PATCH', async () => {
  const { deps, calls, settle } = makeDeps([
    cdnRoute,
    createEmojiRoute({ status: 400, body: { code: 30008, message: 'Maximum number of emojis reached (50)' } }),
    editOriginalRoute,
  ]);
  const res = await handleInteraction(signedRequest(commandPayload({})), ENV, deps);
  assert.deepEqual(await readJson(res), { type: 5 });
  await settle();

  const content = patchContent(calls);
  assert.match(content, /^Could not crib/);
  assert.match(content, /emoji/i);
  assert.match(content, /(full|maximum|limit|slots?|no room)/i);
  assert.ok(!content.includes(BOT_TOKEN));
});

test('unexpected error -> generic failure, logged, no leak', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  const { deps: baseDeps, calls, settle } = makeDeps([editOriginalRoute]);
  // A CDN "response" that is not a Response at all makes downloadEmoji throw a
  // plain TypeError (not a CribError), exercising the generic-failure path.
  const deps: Deps = {
    ...baseDeps,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        calls.push({ url: String(input), method, headers: new Headers(), body: undefined });
        return { headers: null, secret: BOT_TOKEN } as unknown as Response;
      }
      return baseDeps.fetch(input, init);
    }) as typeof fetch,
  };
  const res = await handleInteraction(signedRequest(commandPayload({})), ENV, deps);
  assert.deepEqual(await readJson(res), { type: 5 });
  await settle();

  assert.ok(errors.length >= 1, 'unexpected errors should be logged');
  const content = patchContent(calls);
  assert.match(content, /^Could not crib/);
  assert.match(content, /went wrong/);
  assert.ok(!content.includes('TypeError'));
  assert.ok(!content.includes(BOT_TOKEN));
});

test('failure of the final edit does not reject the background promise', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { deps, settle, pending } = makeDeps([
    cdnRoute,
    createEmojiRoute({ status: 201, body: { id: NEW_EMOJI_ID, name: 'party_parrot', animated: false } }),
    (call) => {
      if (call.method === 'PATCH') throw new Error('network down');
      return undefined;
    },
  ]);
  const res = await handleInteraction(signedRequest(commandPayload({})), ENV, deps);
  assert.deepEqual(await readJson(res), { type: 5 });
  assert.equal(pending.length, 1);
  await settle();
});
