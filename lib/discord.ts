import { candidateUrls, type EmojiRef } from './emoji.js';

export type FetchFn = typeof fetch;

/** An error whose message is safe and friendly to show to the Discord user. */
export class CribError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CribError';
  }
}

export const MAX_EMOJI_BYTES = 256 * 1024;

const API_BASE = 'https://discord.com/api/v10';

/** Discord JSON error body: `{ code, message, errors? }`. */
interface DiscordErrorBody {
  code?: number;
  message?: string;
  errors?: unknown;
  retry_after?: number;
}

/** Cancel an unused response body so the connection can be released. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

function mediaType(contentType: string | null): string | null {
  if (!contentType) return null;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^image\/[a-z0-9.+-]+$/.test(type) ? type : null;
}

function tooLargeError(): CribError {
  return new CribError(
    "That emoji is too large: Discord's limit for emojis is 256 KB.",
  );
}

/**
 * Download the emoji from Discord's CDN, trying each candidate URL in order.
 * Returns a `data:` URI suitable for the Create Guild Emoji endpoint.
 */
export async function downloadEmoji(
  ref: EmojiRef,
  fetchFn: FetchFn,
): Promise<{ dataUri: string }> {
  let sawTooLarge = false;

  for (const url of candidateUrls(ref)) {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { Accept: 'image/*' } });
    } catch {
      continue;
    }

    const type = mediaType(res.headers.get('content-type'));
    if (!res.ok || type === null) {
      await discardBody(res);
      continue;
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_EMOJI_BYTES) {
      await discardBody(res);
      sawTooLarge = true;
      continue;
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await res.arrayBuffer();
    } catch {
      continue;
    }
    if (bytes.byteLength > MAX_EMOJI_BYTES) {
      // A later candidate (e.g. the resized WebP) may still fit.
      sawTooLarge = true;
      continue;
    }
    if (bytes.byteLength === 0) continue;

    const base64 = Buffer.from(bytes).toString('base64');
    return { dataUri: `data:${type};base64,${base64}` };
  }

  if (sawTooLarge) throw tooLargeError();
  throw new CribError(
    "Couldn't download that emoji from Discord. It may have been deleted.",
  );
}

/** Flatten Discord's nested `errors` object into "field: message" strings. */
function flattenErrors(errors: unknown, path: string[] = [], out: string[] = []): string[] {
  if (errors === null || typeof errors !== 'object') return out;
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    if (key === '_errors' && Array.isArray(value)) {
      for (const e of value) {
        const message =
          e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
            ? (e as { message: string }).message
            : null;
        if (message) out.push(path.length ? `${path.join('.')}: ${message}` : message);
      }
    } else {
      flattenErrors(value, [...path, key], out);
    }
  }
  return out;
}

/** Collect every nested error `code` string (e.g. "BINARY_TYPE_MAX_SIZE"). */
function nestedErrorCodes(errors: unknown, out: string[] = []): string[] {
  if (errors === null || typeof errors !== 'object') return out;
  if (Array.isArray(errors)) {
    for (const e of errors) nestedErrorCodes(e, out);
    return out;
  }
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    if (key === 'code' && typeof value === 'string') out.push(value);
    else nestedErrorCodes(value, out);
  }
  return out;
}

const SIZE_ERROR_CODES = new Set([
  40005, // Request entity too large
  50045, // File uploaded exceeds the maximum size
  50138, // Failed to resize asset below the maximum size
]);

function isSizeError(status: number, body: DiscordErrorBody): boolean {
  if (status === 413) return true;
  if (body.code !== undefined && SIZE_ERROR_CODES.has(body.code)) return true;
  const nested = nestedErrorCodes(body.errors);
  if (nested.some((c) => /MAX_SIZE|TOO_LARGE/i.test(c))) return true;
  const text = [body.message ?? '', ...flattenErrors(body.errors)].join(' ');
  return /too large|larger than|maximum size/i.test(text);
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function mapCreateEmojiError(status: number, body: DiscordErrorBody): CribError {
  const code = body.code;

  if (status === 429) {
    const wait =
      typeof body.retry_after === 'number' && body.retry_after > 0
        ? ` Try again in about ${Math.ceil(body.retry_after)} seconds.`
        : ' Try again shortly.';
    return new CribError(`Discord is rate limiting emoji uploads.${wait}`);
  }
  if (code === 30008) {
    return new CribError('This server has no emoji slots left. Remove an emoji or boost the server to get more.');
  }
  if (code === 30018) {
    return new CribError('This server has no animated emoji slots left. Remove an animated emoji or boost the server to get more.');
  }
  if (code === 50001) {
    return new CribError("I can't access this server. Make sure the bot has been added to it (not just the app command).");
  }
  if (code === 50013 || status === 403) {
    return new CribError('I need the "Create Expressions" permission in this server to add emojis. Ask a server admin to grant it to my role.');
  }
  if (isSizeError(status, body)) {
    return new CribError("That emoji's image is too big for Discord to accept (the limit is 256 KB).");
  }
  if (code === 50035) {
    const details = flattenErrors(body.errors);
    const detail = details.length ? ` ${truncate(details.join('; '))}` : '';
    return new CribError(`Discord rejected the emoji name or image.${detail}`);
  }

  const message = body.message ? `: ${truncate(body.message)}` : '';
  return new CribError(`Discord couldn't create the emoji (HTTP ${status}${message}).`);
}

async function readErrorBody(res: Response): Promise<DiscordErrorBody> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      return {
        code: typeof obj.code === 'number' ? obj.code : undefined,
        message: typeof obj.message === 'string' ? obj.message : undefined,
        errors: obj.errors,
        retry_after: typeof obj.retry_after === 'number' ? obj.retry_after : undefined,
      };
    }
  } catch {
    // not JSON
  }
  return {};
}

/** Create an emoji in a guild via `POST /guilds/{guild.id}/emojis`. */
export async function createGuildEmoji(
  args: { guildId: string; name: string; dataUri: string; botToken: string; reason?: string },
  fetchFn: FetchFn,
): Promise<{ id: string; name: string; animated: boolean }> {
  const headers: Record<string, string> = {
    Authorization: `Bot ${args.botToken}`,
    'Content-Type': 'application/json',
  };
  if (args.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(args.reason);

  let res: Response;
  try {
    res = await fetchFn(`${API_BASE}/guilds/${encodeURIComponent(args.guildId)}/emojis`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: args.name, image: args.dataUri }),
    });
  } catch {
    throw new CribError("Couldn't reach Discord to create the emoji. Try again shortly.");
  }

  if (!res.ok) {
    throw mapCreateEmojiError(res.status, await readErrorBody(res));
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CribError('Discord returned an unexpected response while creating the emoji.');
  }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : null;
  if (!id) {
    throw new CribError('Discord returned an unexpected response while creating the emoji.');
  }
  return {
    id,
    name: typeof obj.name === 'string' ? obj.name : args.name,
    animated: obj.animated === true,
  };
}

/** Edit the original deferred interaction response. */
export async function editOriginalResponse(
  args: { applicationId: string; interactionToken: string; content: string },
  fetchFn: FetchFn,
): Promise<void> {
  const url =
    `${API_BASE}/webhooks/${encodeURIComponent(args.applicationId)}` +
    `/${encodeURIComponent(args.interactionToken)}/messages/@original`;
  const res = await fetchFn(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: args.content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = truncate(await res.text(), 200);
    } catch {
      // ignore
    }
    // Do not include the URL: it contains the interaction token.
    throw new Error(
      `Failed to edit original interaction response: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
    );
  }
  await discardBody(res);
}
