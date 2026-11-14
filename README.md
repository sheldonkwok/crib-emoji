# crib-emoji

A Discord slash command that copies an emoji into your server from its link. It runs as a single Vercel serverless function using Discord's HTTP interactions, so there is no bot process to keep online.

## Usage

```text
/crib-emoji name:<emoji_name> link:<emoji link>
```

To get an emoji link, right-click an emoji in any message (long-press on mobile) and choose **Copy Link**. It looks like:

```text
https://cdn.discordapp.com/emojis/123456789012345678.webp?size=48&animated=true
```

The bot downloads that emoji and adds it to the server where you ran the command, under the name you gave.

## How it works

- One Vercel function, `api/interactions.ts`, served at the URL path `/api/interactions`. Discord sends every interaction there.
- Each request's signature is verified against the application's public key; unsigned or forged requests are rejected.
- Only Discord CDN emoji links are accepted. The emoji ID is extracted from the link and the download URL is rebuilt from it, so arbitrary URLs are never fetched.
- The reply is deferred right away (Discord requires an answer within 3 seconds), and the download and upload finish in the background before the response is edited with the result.
- Animated emojis are supported.

## Setup

### 1. Create the Discord application

At https://discord.com/developers/applications create a new application. On **General Information**, copy the **Application ID** and **Public Key**. On the **Bot** page, reset and copy the bot **token**.

### 2. Deploy to Vercel

Deploy this repository to Vercel, then in the project's **Settings → Environment Variables** set:

- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`

Redeploy after setting them so the running deployment picks them up.

### 3. Set the Interactions Endpoint URL

In the Developer Portal, on **General Information**, set **Interactions Endpoint URL** to:

```text
https://<your-deployment>/api/interactions
```

Discord sends a signed test request as soon as you save, so the environment variables from step 2 must already be live or the URL will be rejected.

### 4. Invite the bot to your server

The bot needs the `bot` and `applications.commands` scopes and the **Create Expressions** permission. Open this URL with your Application ID filled in:

```text
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=8796093022208
```

### 5. Register the command

Copy `.env.example` to `.env` and fill in `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN`:

```bash
cp .env.example .env
```

Then register:

```bash
npm run register
```

This registers the command globally, which can take a while to show up in clients. To register it instantly in a single server while testing, also set `DISCORD_GUILD_ID` in `.env` to that server's ID. Running the script again overwrites the registration, so it is safe to rerun after changes.

## Limits and errors

- Emoji files must be 256 KB or smaller.
- Names must be 2 to 32 characters, using only letters, numbers and underscores.
- The number of emoji slots (static and animated are counted separately) depends on the server's boost level; once the server is full, Discord rejects new ones until a slot is freed.
- The bot itself needs the **Create Expressions** permission in the server. Without it, Discord refuses the upload.

## Who can use it

By default, only members with the **Create Expressions** permission can see and run the command. Server admins can change this in **Server Settings → Integrations → crib-emoji**, where they can allow or deny specific roles, members or channels.

## Development

Run the tests:

```bash
npm test
```

Type-check:

```bash
npm run typecheck
```
