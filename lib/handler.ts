import { verifyKey } from 'discord-interactions';
import { COMMAND_NAME } from './command.js';
import { CribError, createGuildEmoji, downloadEmoji, editOriginalResponse } from './discord.js';
import type { FetchFn } from './discord.js';
import { isValidEmojiName, parseEmojiLink } from './emoji.js';
import type { EmojiRef } from './emoji.js';

export interface Env {
  publicKey: string;
  botToken: string;
}

export interface Deps {
  fetch: FetchFn;
  waitUntil: (promise: Promise<unknown>) => void;
}

// Discord interaction constants (only the ones this command needs).
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

const EPHEMERAL_FLAG = 64;

// Minimal shapes of the parts of an interaction payload we read. Everything is
// optional because the body comes from the network and is treated defensively.
interface InteractionUser {
  id?: string;
  username?: string;
}

interface CommandOption {
  name?: string;
  type?: number;
  value?: unknown;
}

interface Interaction {
  type?: number;
  application_id?: string;
  token?: string;
  guild_id?: string;
  member?: { user?: InteractionUser };
  user?: InteractionUser;
  data?: {
    name?: string;
    options?: CommandOption[];
  };
}

const NAME_RULE =
  'Emoji names must be 2-32 characters long and use only letters, numbers and underscores.';
const LINK_HELP =
  'That does not look like a Discord emoji link. Right-click an emoji in Discord (or long-press it on mobile), ' +
  'choose **Copy Link**, and paste it here. It should look like `https://cdn.discordapp.com/emojis/...`.';
const GENERIC_FAILURE = 'Could not crib that emoji: something went wrong on our side. Please try again later.';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ephemeral(content: string): Response {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL_FLAG },
  });
}

function getStringOption(options: unknown, name: string): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options as unknown[]) {
    if (option && typeof option === 'object') {
      const opt = option as CommandOption;
      if (opt.name === name && typeof opt.value === 'string') return opt.value.trim();
    }
  }
  return undefined;
}

function renderEmoji(emoji: { id: string; name: string; animated: boolean }): string {
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

export async function handleInteraction(request: Request, env: Env, deps: Deps): Promise<Response> {
  // 1. Verify the signature before trusting anything in the body.
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const rawBody = await request.text();

  if (!signature || !timestamp) {
    return new Response('Missing request signature', { status: 401 });
  }
  const valid = await verifyKey(rawBody, signature, timestamp, env.publicKey);
  if (!valid) {
    return new Response('Bad request signature', { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!parsed || typeof parsed !== 'object') {
    return json({ error: 'Invalid interaction' }, 400);
  }
  const interaction = parsed as Interaction;

  // 2. PING
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // 3. Slash command
  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === COMMAND_NAME) {
    return handleCribCommand(interaction, env, deps);
  }

  // 4. Anything else
  return json({ error: 'Unknown interaction' }, 400);
}

function handleCribCommand(interaction: Interaction, env: Env, deps: Deps): Response {
  const guildId = interaction.guild_id;
  if (typeof guildId !== 'string' || guildId === '') {
    return ephemeral('`/crib-emoji` only works in a server, not in DMs.');
  }

  const options = interaction.data?.options;
  const name = getStringOption(options, 'name');
  const link = getStringOption(options, 'link');

  if (name === undefined || !isValidEmojiName(name)) {
    return ephemeral(NAME_RULE);
  }

  const ref = link === undefined ? null : parseEmojiLink(link);
  if (!ref) {
    return ephemeral(LINK_HELP);
  }

  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (typeof applicationId !== 'string' || typeof interactionToken !== 'string') {
    return json({ error: 'Malformed interaction' }, 400);
  }

  const user = interaction.member?.user ?? interaction.user;
  const username = typeof user?.username === 'string' ? user.username : 'unknown user';
  const userId = typeof user?.id === 'string' ? user.id : 'unknown id';
  const reason = `Cribbed by ${username} (${userId}) via /${COMMAND_NAME}`;

  deps.waitUntil(
    cribInBackground({ ref, name, guildId, reason, applicationId, interactionToken }, env, deps),
  );

  return json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
}

interface CribJob {
  ref: EmojiRef;
  name: string;
  guildId: string;
  reason: string;
  applicationId: string;
  interactionToken: string;
}

/** Does the slow work after the deferred response. Never rejects. */
async function cribInBackground(job: CribJob, env: Env, deps: Deps): Promise<void> {
  let content: string;
  try {
    const { dataUri } = await downloadEmoji(job.ref, deps.fetch);
    const emoji = await createGuildEmoji(
      { guildId: job.guildId, name: job.name, dataUri, botToken: env.botToken, reason: job.reason },
      deps.fetch,
    );
    content = `Cribbed ${renderEmoji(emoji)} as \`:${emoji.name}:\``;
  } catch (err) {
    if (err instanceof CribError) {
      content = `Could not crib that emoji: ${err.message}`;
    } else {
      console.error('crib-emoji: unexpected error while cribbing emoji', err);
      content = GENERIC_FAILURE;
    }
  }

  try {
    await editOriginalResponse(
      { applicationId: job.applicationId, interactionToken: job.interactionToken, content },
      deps.fetch,
    );
  } catch (err) {
    console.error('crib-emoji: failed to edit the original interaction response', err);
  }
}
