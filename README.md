# Karting Oracle Bot V4

A Discord bot built with Node.js, TypeScript, `discord.js`, the OpenAI Responses API, and Supabase. Each server chooses one Oracle channel in Discord. Questions, AI answers, votes, moderator verification, and verified community knowledge are persisted in Supabase.

V4 keeps V3 voting behavior and adds:

- A moderator-controlled **Verify Answer** / **Unverify** button.
- Permanent verification metadata recording who verified an answer and when.
- Verified-only full-text retrieval of up to three relevant previous answers.
- A subtle `📚 Informed by verified community knowledge` note when that context materially influenced a new answer.

Unverified answers are never used as trusted knowledge, regardless of their vote totals.

## Prerequisites

- Node.js 22 or newer
- A Discord application with a bot token
- An OpenAI API key with available credit
- A Supabase project with the V3 schema
- A Discord role whose members are allowed to verify answers

## Discord setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), then add a bot on the **Bot** page.
2. Enable the privileged **Message Content Intent**.
3. Under **OAuth2 > URL Generator**, select the `bot` and `applications.commands` scopes and grant:
   - View Channels
   - Send Messages
   - Read Message History
4. Invite the bot to your server.
5. Start the bot, then run `/oracle setup` in the server. Members with **Manage Server** or any role in `MODERATOR_ROLE_IDS` may use it.

The setup command responds ephemerally with Discord's native text-channel selector. It can be rerun at any time to refresh the available channels or change the saved Oracle channel, which is shown as the current default. Private text channels can be selected when current Discord permissions make them available, and the bot rechecks **View Channel**, **Send Messages**, and **Read Message History** before saving. If any permission is missing, setup shows an error and keeps the selector available for another attempt. After a successful selection, the dropdown is removed and replaced with `✅ Karting Oracle channel set to #channel-name`. Each setup run also logs a freshly fetched inventory containing every channel's ID, name, and Discord type to help diagnose channels omitted by Discord's native selector; this diagnostic inventory never filters the selector options.

No `ORACLE_CHANNEL_ID` environment variable is needed.

### Create and copy the moderator role IDs

1. In Discord, open **Server Settings > Roles**.
2. Create or select one or more roles whose members should be allowed to verify answers.
3. Open **User Settings > Advanced** and enable **Developer Mode**.
4. Return to **Server Settings > Roles**, right-click each moderator role, and select **Copy Role ID**.
5. Paste the numeric IDs into `MODERATOR_ROLE_IDS` in `.env`, separated by commas.

For example:

```dotenv
MODERATOR_ROLE_IDS=123456789,987654321,555555555
```

Whitespace around IDs and empty entries are ignored. A member is a moderator if they have any one of the configured roles. The verification button is visible on bot answers so moderators can use it. Permission is not based on visibility: every click is checked by the running bot against all configured role IDs before any database update occurs.

## Supabase setup and V4 migration

### Existing V3 project

1. Sign in at [Supabase](https://supabase.com/dashboard) and open the existing project.
2. Open **SQL Editor** and select **New query**.
3. Open [`supabase/migrations/20260826010000_add_oracle_v4_verification.sql`](supabase/migrations/20260826010000_add_oracle_v4_verification.sql).
4. Copy the entire file into the Supabase query and select **Run**.
5. Open **Table Editor > answers** and confirm these columns exist:
   - `is_verified`
   - `verified_by_discord_user_id`
   - `verified_at`

The V4 migration is safe to run again if a previous attempt was interrupted.

### New Supabase project

Run these files in order in the SQL Editor:

1. [`supabase/migrations/20260826000000_create_oracle_v3_schema.sql`](supabase/migrations/20260826000000_create_oracle_v3_schema.sql)
2. [`supabase/migrations/20260826010000_add_oracle_v4_verification.sql`](supabase/migrations/20260826010000_add_oracle_v4_verification.sql)

The V4 migration adds service-role-only database functions for verification and verified knowledge search. Row Level Security remains enabled, and `anon` and `authenticated` users are not granted access. Never paste the Secret/service-role key into Discord, source files, `.env.example`, screenshots, or logs.

## Environment variables

Create `.env` from the example if it does not already exist:

```powershell
Copy-Item .env.example .env
```

Fill in all five values in `.env`:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_your_backend_secret_key
MODERATOR_ROLE_IDS=123456789,987654321,555555555
```

Where to find them:

- `DISCORD_TOKEN`: Discord Developer Portal, your application, **Bot > Reset Token/Copy**.
- `OPENAI_API_KEY`: OpenAI API dashboard, **API keys**.
- `SUPABASE_URL`: Supabase project **Connect** dialog or **Integrations > Data API**. The base project URL and the displayed `/rest/v1/` URL are both accepted.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase **Settings > API Keys**, backend Secret key beginning with `sb_secret_`; a legacy `service_role` key also works.
- `MODERATOR_ROLE_IDS`: one or more numeric Discord role IDs copied using Developer Mode, separated by commas.

For backwards compatibility, the bot still accepts the singular `MODERATOR_ROLE_ID` variable when `MODERATOR_ROLE_IDS` is missing or contains no usable IDs. New configurations should use `MODERATOR_ROLE_IDS`.

`.env` and `.env.*` are excluded by `.gitignore`; `.env.example` contains placeholders only.

## Install, check, and run

```powershell
npm install
npm run check
npm start
```

`npm run check` runs Biome linting, TypeScript compilation, and the automated tests. A successful startup prints messages similar to:

```text
Logged in as Karting Oracle#3040.
Supabase persistence is ready.
Listening in #your-channel on Your Server.
```

## How V4 retrieval works

Before requesting a new OpenAI answer, the bot asks Supabase for at most three full-text matches. The database function filters to `answers.is_verified = true` before returning anything. Matching considers both the earlier question and its answer.

The selected text is supplied privately to OpenAI as trusted supporting context. The model is instructed to synthesise a fresh answer, state uncertainty, and never invent track-specific facts, rules, or regulations. Database IDs, relevance scores, verification metadata, and raw search results are not shown in Discord.

If retrieval fails, the failure is logged safely and the bot answers normally without trusted context. Other database failures produce a user-friendly message without crashing the bot or exposing credentials.

## Test V4 in Discord

### 1. Verify an answer

1. Ensure your Discord account has at least one role listed in `MODERATOR_ROLE_IDS`.
2. Ask a distinctive karting question in the configured Oracle channel.
3. Click **Verify Answer** beneath the response.
4. Confirm only you receive the ephemeral message: `Answer verified. It can now support similar future answers.`
5. Confirm the public answer now shows `✅ Verified by a moderator` and the button changes to **Unverify**.
6. In Supabase **Table Editor > answers**, locate the answer and confirm:
   - `is_verified` is `true`.
   - `verified_by_discord_user_id` contains your Discord user ID.
   - `verified_at` contains a timestamp.

### 2. Unverify it

1. Click **Unverify** on the verified answer.
2. Confirm the ephemeral message says it will no longer be used as trusted knowledge.
3. Confirm the public verified badge disappears and the button changes back to **Verify Answer**.
4. In Supabase, confirm `is_verified` is `false` and both `verified_by_discord_user_id` and `verified_at` are cleared.

### 3. Confirm verified knowledge is used

1. Verify the original answer again.
2. Ask a new question using some of the same meaningful karting terms but different wording. For example, if the verified question discussed wet-weather tyre pressure, ask another question containing `wet`, `tyre pressure`, and the same kart class or setup topic.
3. When verified context materially informs the new answer, confirm it ends with:

   ```text
   📚 Informed by verified community knowledge
   ```

4. Unverify the original answer and ask the similar question again. It must no longer be eligible as trusted context, and that original answer alone must not cause the `📚` line to appear.

Full-text matching is deliberately simple in V4. If the first similar question does not match, repeat it with one or two distinctive terms from the verified question.

### 4. Confirm a non-moderator is denied

1. Use a second Discord account, or temporarily test with an account that has none of the configured moderator roles.
2. Click **Verify Answer**.
3. Confirm only that user sees the ephemeral denial: `Only members with a configured moderator role can verify answers.`
4. Confirm the public answer, button, and Supabase verification fields remain unchanged.

Finally, repeat the V3 voting checks: cast Helpful and Not Helpful votes, change a vote, ask multiple questions, and restart the bot. Vote totals and verification state should remain persisted and independent for every answer.

## Notes

- Each Discord question is sent to OpenAI as a separate request.
- The bot continues to use `gpt-5-mini` and keeps replies within Discord's 2,000-character limit.
- Messages from other channels, bots, direct messages, and empty messages are ignored.
- Channel choices remain in the local ignored file `data/guild-config.json`.
- Questions, answers, votes, and verification metadata live in Supabase.
