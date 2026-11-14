/** Name of the slash command, as typed by users (`/crib-emoji`). */
export const COMMAND_NAME = 'crib-emoji';

/** Permission bit for "Create Expressions" (1 << 43), as Discord expects it: a decimal string. */
export const CREATE_GUILD_EXPRESSIONS = '8796093022208';

/**
 * Body for Discord's application-command API.
 * https://discord.com/developers/docs/interactions/application-commands
 */
export const commandDefinition = {
  name: COMMAND_NAME,
  type: 1, // CHAT_INPUT
  description: 'Copy an emoji into this server from its link',
  options: [
    {
      type: 3, // STRING
      name: 'name',
      description: 'Name for the emoji in this server',
      required: true,
      min_length: 2,
      max_length: 32,
    },
    {
      type: 3, // STRING
      name: 'link',
      description: 'Emoji link (right-click an emoji → Copy Link)',
      required: true,
    },
  ],
  // Only usable inside servers (GUILD context), only as a server-installed app (GUILD_INSTALL).
  contexts: [0],
  integration_types: [0],
  // By default only members who can add emojis may run it; admins can override in Integrations settings.
  default_member_permissions: CREATE_GUILD_EXPRESSIONS,
} as const;
