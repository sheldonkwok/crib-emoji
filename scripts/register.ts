import { pathToFileURL } from 'node:url';
import { commandDefinition } from '../lib/command.js';

const API_BASE = 'https://discord.com/api/v10';
const REQUIRED_ENV = ['DISCORD_APPLICATION_ID', 'DISCORD_BOT_TOKEN'] as const;

export type RegisterEnv = Record<string, string | undefined>;

export interface RegisterRequest {
  url: string;
  init: RequestInit;
  /** Human-readable description of where the command is registered. */
  target: string;
}

/**
 * Builds the bulk-overwrite request that registers the command, either globally or,
 * when DISCORD_GUILD_ID is set, in a single guild (which updates instantly).
 * Throws an Error naming any missing required variables. Never includes the token in messages.
 */
export function buildRegisterRequest(env: RegisterEnv): RegisterRequest {
  const value = (key: string): string | undefined => {
    const v = env[key]?.trim();
    return v ? v : undefined;
  };

  const missing = REQUIRED_ENV.filter((key) => !value(key));
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }

  const appId = value('DISCORD_APPLICATION_ID')!;
  const token = value('DISCORD_BOT_TOKEN')!;
  const guildId = value('DISCORD_GUILD_ID');

  const app = encodeURIComponent(appId);
  const url = guildId
    ? `${API_BASE}/applications/${app}/guilds/${encodeURIComponent(guildId)}/commands`
    : `${API_BASE}/applications/${app}/commands`;

  return {
    url,
    target: guildId ? `guild ${guildId}` : 'globally (may take a while to appear)',
    init: {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (crib-emoji, 1.0.0)',
      },
      body: JSON.stringify([commandDefinition]),
    },
  };
}

async function main(): Promise<void> {
  let request: RegisterRequest;
  try {
    request = buildRegisterRequest(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const res = await fetch(request.url, request.init);
  const text = await res.text();

  if (!res.ok) {
    console.error(`Discord rejected the registration: ${res.status} ${res.statusText}`);
    console.error(text);
    process.exit(1);
  }

  let names = `/${commandDefinition.name}`;
  try {
    const commands = JSON.parse(text) as Array<{ name: string; id: string }>;
    names = commands.map((c) => `/${c.name} (id ${c.id})`).join(', ');
  } catch {
    // Keep the default description if the body is not the expected JSON.
  }
  console.log(`Registered ${names} ${request.target}.`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    console.error('Registration failed:', err instanceof Error ? err.message + cause : err);
    process.exit(1);
  });
}
