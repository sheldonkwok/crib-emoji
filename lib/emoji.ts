export interface EmojiRef {
  id: string;
  animated: boolean;
}

const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const CDN_BASE = 'https://cdn.discordapp.com/emojis/';

// /emojis/<snowflake>[.<ext>]
const EMOJI_PATH = /^\/emojis\/(\d{15,22})(?:\.(png|webp|gif|jpg|jpeg|avif))?$/i;

const VALID_NAME = /^[A-Za-z0-9_]{2,32}$/;

/**
 * Returns null unless the link is an https Discord CDN emoji link.
 *
 * Security boundary: callers must never fetch the user-supplied URL. We only
 * extract the emoji ID here, and `candidateUrls` rebuilds the URL ourselves.
 */
export function parseEmojiLink(link: string): EmojiRef | null {
  if (typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;

  const match = EMOJI_PATH.exec(url.pathname);
  if (!match) return null;
  const id = match[1];
  if (id === undefined) return null;
  const ext = match[2]?.toLowerCase();

  const animated = ext === 'gif' || url.searchParams.get('animated') === 'true';
  return { id, animated };
}

/** Discord emoji names: 2-32 chars, letters, digits, underscore. */
export function isValidEmojiName(name: string): boolean {
  return typeof name === 'string' && VALID_NAME.test(name);
}

/** URLs to try in order when downloading the emoji. */
export function candidateUrls(ref: EmojiRef): string[] {
  const base = `${CDN_BASE}${ref.id}`;
  if (ref.animated) {
    // Newer animated emojis uploaded as WebP/AVIF cannot be served as GIF,
    // so fall back to animated WebP.
    return [`${base}.gif`, `${base}.webp?animated=true&size=128`];
  }
  return [`${base}.png?size=128`];
}
