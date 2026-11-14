import { waitUntil } from '@vercel/functions';
import { handleInteraction } from '../lib/handler.js';

export async function POST(request: Request): Promise<Response> {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  const missing = [
    publicKey ? null : 'DISCORD_PUBLIC_KEY',
    botToken ? null : 'DISCORD_BOT_TOKEN',
  ].filter((v): v is string => v !== null);

  if (!publicKey || !botToken) {
    const message = `Server misconfigured: missing environment variable(s) ${missing.join(', ')}`;
    console.error(message);
    return new Response(message, { status: 500 });
  }

  return handleInteraction(request, { publicKey, botToken }, { fetch: globalThis.fetch, waitUntil });
}
