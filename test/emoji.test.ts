import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidateUrls, isValidEmojiName, parseEmojiLink } from '../lib/emoji.js';

const ID = '123456789012345678';

describe('parseEmojiLink', () => {
  it('parses a static png link', () => {
    assert.deepEqual(parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.png`), {
      id: ID,
      animated: false,
    });
  });

  it('parses a webp link with size query', () => {
    assert.deepEqual(
      parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.webp?size=48&quality=lossless`),
      { id: ID, animated: false },
    );
  });

  it('treats gif as animated', () => {
    assert.deepEqual(parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.gif`), {
      id: ID,
      animated: true,
    });
    assert.deepEqual(parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.GIF?v=1`), {
      id: ID,
      animated: true,
    });
  });

  it('treats animated=true query as animated', () => {
    assert.deepEqual(
      parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.webp?size=48&animated=true`),
      { id: ID, animated: true },
    );
    assert.deepEqual(
      parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.webp?animated=false`),
      { id: ID, animated: false },
    );
  });

  it('accepts other allowed extensions case-insensitively, and no extension', () => {
    for (const ext of ['jpg', 'jpeg', 'avif', 'PNG', 'WebP', 'JPEG']) {
      assert.deepEqual(parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}.${ext}`), {
        id: ID,
        animated: false,
      }, ext);
    }
    assert.deepEqual(parseEmojiLink(`https://cdn.discordapp.com/emojis/${ID}`), {
      id: ID,
      animated: false,
    });
  });

  it('accepts the media.discordapp.net host', () => {
    assert.deepEqual(
      parseEmojiLink(`https://media.discordapp.net/emojis/${ID}.webp?size=96&animated=true`),
      { id: ID, animated: true },
    );
  });

  it('accepts uppercase host and fragment', () => {
    assert.deepEqual(parseEmojiLink(`https://CDN.DiscordApp.com/emojis/${ID}.png#x`), {
      id: ID,
      animated: false,
    });
  });

  it('trims whitespace', () => {
    assert.deepEqual(parseEmojiLink(`  \n https://cdn.discordapp.com/emojis/${ID}.png \t `), {
      id: ID,
      animated: false,
    });
  });

  it('accepts snowflakes of 15 to 22 digits only', () => {
    assert.ok(parseEmojiLink(`https://cdn.discordapp.com/emojis/${'1'.repeat(15)}.png`));
    assert.ok(parseEmojiLink(`https://cdn.discordapp.com/emojis/${'1'.repeat(22)}.png`));
    assert.equal(parseEmojiLink(`https://cdn.discordapp.com/emojis/${'1'.repeat(14)}.png`), null);
    assert.equal(parseEmojiLink(`https://cdn.discordapp.com/emojis/${'1'.repeat(23)}.png`), null);
  });

  const rejected: Array<[string, string]> = [
    ['http scheme', `http://cdn.discordapp.com/emojis/${ID}.png`],
    ['ftp scheme', `ftp://cdn.discordapp.com/emojis/${ID}.png`],
    ['lookalike suffix host', `https://cdn.discordapp.com.evil.com/emojis/${ID}.png`],
    ['lookalike prefix host', `https://evilcdn.discordapp.com/emojis/${ID}.png`],
    ['subdomain of allowed host', `https://x.cdn.discordapp.com/emojis/${ID}.png`],
    ['other discord host', `https://discord.com/emojis/${ID}.png`],
    ['other host', `https://example.com/emojis/${ID}.png`],
    ['trailing-dot host', `https://cdn.discordapp.com./emojis/${ID}.png`],
    ['userinfo trick', `https://cdn.discordapp.com@evil.com/emojis/${ID}.png`],
    ['credentials', `https://user:pass@cdn.discordapp.com/emojis/${ID}.png`],
    ['explicit port', `https://cdn.discordapp.com:8443/emojis/${ID}.png`],
    ['attachments path', `https://cdn.discordapp.com/attachments/${ID}/${ID}/image.png`],
    ['stickers path', `https://media.discordapp.net/stickers/${ID}.png`],
    ['avatars path', `https://cdn.discordapp.com/avatars/${ID}/abc.png`],
    ['extra path segment', `https://cdn.discordapp.com/emojis/${ID}/x.png`],
    ['trailing slash', `https://cdn.discordapp.com/emojis/${ID}.png/`],
    ['path traversal', `https://cdn.discordapp.com/emojis/../attachments/${ID}.png`],
    ['non-numeric id', 'https://cdn.discordapp.com/emojis/abcdefghijklmnopqr.png'],
    ['mixed id', `https://cdn.discordapp.com/emojis/${ID}abc.png`],
    ['bad extension', `https://cdn.discordapp.com/emojis/${ID}.svg`],
    ['double extension', `https://cdn.discordapp.com/emojis/${ID}.png.gif`],
    ['encoded path', `https://cdn.discordapp.com/emojis/%31${ID.slice(1)}.png`],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['garbage', 'not a url'],
    ['custom emoji markup', `<:blob:${ID}>`],
    ['bare id', ID],
    ['javascript url', 'javascript:alert(1)'],
    ['data url', 'data:image/png;base64,AAAA'],
  ];
  for (const [label, link] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(parseEmojiLink(link), null);
    });
  }
});

describe('isValidEmojiName', () => {
  it('accepts valid names', () => {
    for (const name of ['ab', 'blob_cat', 'Party123', '__', 'a'.repeat(32), 'A1_']) {
      assert.equal(isValidEmojiName(name), true, name);
    }
  });

  it('rejects invalid names', () => {
    for (const name of [
      '',
      'a',
      'a'.repeat(33),
      'has space',
      'dash-name',
      'colon:',
      ':blob:',
      'emoji!',
      'é_accent',
      'name\n',
      '😀😀',
    ]) {
      assert.equal(isValidEmojiName(name), false, JSON.stringify(name));
    }
  });
});

describe('candidateUrls', () => {
  it('returns gif then animated webp for animated emojis', () => {
    assert.deepEqual(candidateUrls({ id: ID, animated: true }), [
      `https://cdn.discordapp.com/emojis/${ID}.gif`,
      `https://cdn.discordapp.com/emojis/${ID}.webp?animated=true&size=128`,
    ]);
  });

  it('returns png for static emojis', () => {
    assert.deepEqual(candidateUrls({ id: ID, animated: false }), [
      `https://cdn.discordapp.com/emojis/${ID}.png?size=128`,
    ]);
  });

  it('always rebuilds on cdn.discordapp.com even for media host links', () => {
    const ref = parseEmojiLink(`https://media.discordapp.net/emojis/${ID}.webp?animated=true`);
    assert.ok(ref);
    for (const url of candidateUrls(ref)) {
      assert.ok(url.startsWith(`https://cdn.discordapp.com/emojis/${ID}.`), url);
    }
  });
});
