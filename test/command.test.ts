import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_NAME, commandDefinition } from '../lib/command.js';
import { buildRegisterRequest } from '../scripts/register.js';

// Discord's documented regex for command and option names.
const NAME_REGEX = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

describe('commandDefinition', () => {
  it('is a chat-input command named crib-emoji', () => {
    assert.equal(COMMAND_NAME, 'crib-emoji');
    assert.equal(commandDefinition.name, COMMAND_NAME);
    assert.equal(commandDefinition.type, 1);
  });

  it('has valid names (lowercase, matching Discord regex)', () => {
    for (const name of [commandDefinition.name, ...commandDefinition.options.map((o) => o.name)]) {
      assert.match(name, NAME_REGEX);
      assert.equal(name, name.toLowerCase());
    }
  });

  it('has descriptions within 1-100 characters', () => {
    for (const d of [commandDefinition.description, ...commandDefinition.options.map((o) => o.description)]) {
      assert.ok(d.length >= 1 && d.length <= 100, `bad description length: ${d}`);
    }
  });

  it('has required string options name then link', () => {
    const opts = commandDefinition.options;
    assert.deepEqual(
      opts.map((o) => o.name),
      ['name', 'link'],
    );
    for (const o of opts) {
      assert.equal(o.type, 3);
      assert.equal(o.required, true);
    }
    assert.equal(opts[0].min_length, 2);
    assert.equal(opts[0].max_length, 32);
  });

  it('is guild-only', () => {
    assert.deepEqual(commandDefinition.contexts, [0]);
    assert.deepEqual(commandDefinition.integration_types, [0]);
  });

  it('defaults to the Create Expressions permission', () => {
    assert.equal(commandDefinition.default_member_permissions, '8796093022208');
    assert.equal(BigInt(commandDefinition.default_member_permissions), 1n << 43n);
  });

  it('serializes to JSON cleanly', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(commandDefinition)), commandDefinition);
  });
});

describe('buildRegisterRequest', () => {
  const env = { DISCORD_APPLICATION_ID: '111', DISCORD_BOT_TOKEN: 'secret-token' };

  it('targets the global commands endpoint by default', () => {
    const { url, init } = buildRegisterRequest(env);
    assert.equal(url, 'https://discord.com/api/v10/applications/111/commands');
    assert.equal(init.method, 'PUT');
  });

  it('targets a guild when DISCORD_GUILD_ID is set', () => {
    const { url } = buildRegisterRequest({ ...env, DISCORD_GUILD_ID: '222' });
    assert.equal(url, 'https://discord.com/api/v10/applications/111/guilds/222/commands');
  });

  it('treats an empty DISCORD_GUILD_ID as unset', () => {
    const { url } = buildRegisterRequest({ ...env, DISCORD_GUILD_ID: '' });
    assert.equal(url, 'https://discord.com/api/v10/applications/111/commands');
  });

  it('sends the bot token and a JSON array body', () => {
    const { init } = buildRegisterRequest(env);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bot secret-token');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(typeof init.body, 'string');
    assert.deepEqual(JSON.parse(init.body as string), [commandDefinition]);
  });

  it('names every missing variable without leaking the token', () => {
    assert.throws(() => buildRegisterRequest({}), (err: Error) => {
      assert.match(err.message, /DISCORD_APPLICATION_ID/);
      assert.match(err.message, /DISCORD_BOT_TOKEN/);
      return true;
    });
    assert.throws(
      () => buildRegisterRequest({ DISCORD_BOT_TOKEN: 'secret-token' }),
      (err: Error) => {
        assert.match(err.message, /DISCORD_APPLICATION_ID/);
        assert.doesNotMatch(err.message, /DISCORD_BOT_TOKEN|secret-token/);
        return true;
      },
    );
    assert.throws(() => buildRegisterRequest({ DISCORD_APPLICATION_ID: '111', DISCORD_BOT_TOKEN: '  ' }), /DISCORD_BOT_TOKEN/);
  });
});
