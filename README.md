# 🐱 Discord CAPTCHA Shield

A drop-in, self-hostable **CAPTCHA + Discord OAuth verification gate** for your
Discord servers — built to run on [Val Town](https://val.town). New members solve
a Cloudflare Turnstile CAPTCHA, authorize with Discord, and a bot automatically
grants them your **Verified** role. Bots and raid scripts don't get in.

**One deployment shields many servers.** Each server gets its own configuration
and branding, stored in SQLite and managed at runtime through a guarded admin
API — no redeploy to onboard a new server.

> Made by **catalloc**. Remix it, re-skin it, ship it. The whole thing is one
> small Val Town project with no build step and no servers to run.

<p align="center"><img src="https://placecats.com/1200/630" alt="Discord CAPTCHA Shield" width="640" /></p>

---

## What you get

- **A branded portal per server** (`/g/{guildId}`) — CAPTCHA → "Continue with
  Discord" → done. Each server's logo, colors, name, and copy are its own.
- **Multi-tenant from one val** — per-server config (role, branding, channels,
  alert tuning, optional Turnstile keys) lives in SQLite, keyed by guild id.
- **A guarded admin API** (`/admin/guilds`) — add, edit, and remove servers at
  runtime with a bearer token. No redeploy.
- **One shared Discord app + bot** — a single OAuth app with **one** registered
  `/callback` redirect URI serves unlimited servers (the guild is carried in the
  one-time state nonce, not the URL).
- **One-time, single-use state nonces** (SQLite) bound to a passed CAPTCHA *and*
  a specific server, so a callback can't be replayed, forged, or cross-wired.
- **Automatic role grant** via the bot using only the `identify` OAuth scope (the
  shield never sees a password and never reads message content).
- **Per-server raid alerts** — a Discord webhook ping when an abnormal number of
  *successful* verifications land in a short window, counted and debounced per
  server (the farmed-account pattern Turnstile can't catch).
- **A dynamic social card per server** (`/g/{guildId}/og.png`) rendered with
  satori + resvg and cached.
- **Per-server DMZ bootstrap** (`setup.ts`) — the bot creates the `#about`,
  `#rules`, `#verify`, and `#do-not-post` channels (read-only, honeypot open)
  and posts every message into them.
- **Editable messages** — re-running a post tool updates the existing message in
  place instead of duplicating it (channel + message IDs are kept in blob,
  namespaced per guild).
- **An audit log** of every attempt (per server), auto-pruned after 7 days.

## How it works

```
Visitor                 Portal (this val)               Discord
  │ GET /g/{id} ───────────▶ load server config + theme (SQLite)
  │                          render CAPTCHA page
  │ solve Turnstile
  │ POST /g/{id}/start ────▶ verify token w/ Cloudflare
  │                          mint one-time state nonce bound to {id}
  │ ◀──────────── OAuth URL
  │ authorize (identify) ─────────────────────────────▶ consent screen
  │ GET /callback?code&state ◀────────────────────────  redirect back
  │                          burn nonce → recover {id},
  │                          exchange code, read user id,
  │                          PUT role in {id} ─────────▶ role granted ✅
  │ ◀──────────── "Verified" result page
```

The `/callback` redirect URI is the **same for every server** — the server is
recovered from the `state` nonce, so you register just one redirect URI in the
Discord app no matter how many servers you shield.

Roles gate **channel access**. Lock `@everyone` down to a single `#verify`
channel and grant the rest to the Verified role — see
[`HARDENING.md`](./HARDENING.md) for the full lockdown + the limits of this model
(DMs / member-list visibility).

---

## Files

```
http.ts          # HTTP trigger — the multi-tenant router (set as HTTP val)
cron.ts          # Cron trigger — daily cleanup + per-server OG card refresh
mod.ts           # Verification logic + routing (Turnstile, OAuth, role grant, UI)
admin.ts         # Guarded /admin API to register & manage servers at runtime
guilds.ts        # Per-server config registry (CRUD over the captcha_guilds table)
schema.ts        # Centralized SQLite schema + migrations
config.ts        # Env split: shared secrets + per-server config loaders
theme.ts         # 🎨 Default branding (per-server overrides live in each server's config)
og.ts            # Per-server /og.png social card generator
store.ts         # Blob-backed store of created channel + posted message IDs (per guild)
channels.ts      # Creates the DMZ channels (used by setup.ts)
setup.ts         # Bot creates the DMZ channels AND posts every message, for one server
post-verify.ts   # Bot posts (or updates) the Verify button for one server
post-rules.ts    # ... the rules embed
post-about.ts    # ... the "About the community" card
post-honeypot.ts # ... the honeypot "do not post" trap
deno.json        # Val Town / Deno config
```

---

## Installation

You'll need ~15 minutes, one or more Discord servers you administer, and free
Cloudflare + Val Town accounts. **One Discord app + bot is shared across every
server you shield.**

### 1. Create ONE Discord application & bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**.
2. **OAuth2** tab → copy the **Client ID** and **Client Secret**.
3. **Bot** tab → **Add Bot** → **Reset Token** and copy the **Bot Token**.
   - The default (non-privileged) intents are fine — this shield never reads
     message content or the member list.
4. **Invite the bot to each server** you want to shield, with the `bot` scope and
   these permissions:

   | Permission | Why |
   | --- | --- |
   | **Manage Roles** | Grant the Verified role on a successful verification |
   | **View Channel** | See the DMZ channels it posts into |
   | **Send Messages** | Post the verify / rules / about / honeypot messages |
   | **Embed Links** | Those messages are rich embeds |

   Quick invite URL (replace `CLIENT_ID`) — the `permissions` integer already
   bundles all four:
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=268454912
   ```

   **Want the bot to auto-create the DMZ channels** via `setup.ts`? Also grant
   **Manage Channels** — use `permissions=268454928` instead. If you'll make the
   channels yourself, the shield never needs it.

### 2. Per server: Verified role & IDs

For **each** server you'll shield:

1. Create a **Verified** role. Copy its ID (enable *Developer Mode* in Discord
   → User Settings → Advanced, then right-click the role → **Copy ID**).
2. **Important — role hierarchy:** drag the **bot's own role above the Verified
   role** in Server Settings → Roles. A bot can only assign roles *below* its
   highest role.
3. Right-click the server → **Copy Server ID** (that's the **Guild ID**).
4. (Recommended) Lock the server down: deny `@everyone` **View Channel**
   everywhere except a single `#verify` channel; grant the real channels to the
   Verified role. See [`HARDENING.md`](./HARDENING.md).

You'll register these IDs with the admin API in step 6.

### 3. Get a Cloudflare Turnstile keypair (free)

1. Cloudflare Dashboard → **Turnstile** → **Add site**.
2. Add the domain you'll serve the portal from (your val's domain — e.g.
   `your-val.val.run`, or a custom domain). You can add `localhost` for testing.
3. Copy the **Site Key** and **Secret Key**.

Because the Turnstile site key is **domain-bound** and every server shares the
portal domain, **one keypair covers all your servers**. (A server on its own
custom domain can set its own keypair — see the admin API fields.)

### 4. Create the val on Val Town

1. **Remix this template** into your own Val Town project (or create a new
   project and copy these files in).
2. Set the triggers:
   - **`http.ts`** → make it an **HTTP** val. Note its URL — that's your portal
     base (servers live at `<base>/g/{guildId}`).
   - **`cron.ts`** → make it a **Cron** val on a daily schedule (e.g. `0 6 * * *`).
3. Add the **shared** environment variables below (Val Town → your project →
   **Environment Variables**). Per-server values are NOT env vars — they go
   through the admin API.

### 5. Configure the OAuth redirect (once)

Back in the Discord Developer Portal → **OAuth2** → **Redirects**, add the single
shared callback:

```
https://<your-portal-domain>/callback
```

This must match exactly, and it's the **only** redirect URI you ever need, for
any number of servers. (A server on a custom domain that sets its own
`redirectUriOverride` needs that URI registered too.)

### 6. Register each server (admin API)

With `ADMIN_SECRET` set (step env table below), register a server by POSTing its
config. Minimum is the guild id + role id; add branding and channels as you like:

```bash
curl -X POST https://<your-portal-domain>/admin/guilds \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{
        "guildId": "111111111111111111",
        "roleId":  "222222222222222222",
        "serverName": "My Community",
        "accentColor": "#5865F2",
        "logoUrl": "https://example.com/logo.png",
        "portalUrl": "https://your-portal-domain/g/111111111111111111",
        "alertWebhookUrl": "https://discord.com/api/webhooks/..."
      }'
```

Members then verify at `https://<your-portal-domain>/g/111111111111111111`.
Repeat for each server. See [Managing servers](#managing-servers) for the full
field list and the other verbs.

> Set **`portalUrl`** to the server's full portal URL (`.../g/{guildId}`) — the
> Verify buttons and the OG card image are built from it.

### 7. Set up each server's DMZ & post the messages

The **DMZ** is the handful of channels an unverified member can see. The tools
act on **one server at a time** — pass the guild id as the first argument, or set
`TOOL_GUILD_ID` in the environment before running. You have two ways to set it
up — pick one.

**Option A — let the bot build it.** Grant the bot **Manage Channels** (step 1),
then run **`setup.ts`** with the guild id. It creates a `Welcome` category with
`#about`, `#rules`, `#verify`, and `#do-not-post` (read-only to `@everyone`,
honeypot left open), then posts every message into them. Channel + message IDs
are saved to blob storage (namespaced per server), so you never copy an ID by
hand.

**Option B — use your own channels.** Create the channels yourself, set the
channel IDs on the server's config (admin API: `verifyChannelId`,
`rulesChannelId`, `aboutChannelId`, `honeypotChannelId`), and run the post
scripts individually:

| Script | Posts | Config field |
| --- | --- | --- |
| `post-about.ts` | "About the community" card (+ Verify button) | `aboutChannelId` |
| `post-rules.ts` | The rules embed | `rulesChannelId` |
| `post-verify.ts` | The Verify button | `verifyChannelId` |
| `post-honeypot.ts` | A "do not post" trap that outs spam bots | `honeypotChannelId` |

Either way: **re-running a post script edits its message in place** — it doesn't
post a duplicate. See [Updating messages](#updating-messages) below. Done — new
members can now read what you're about, see the rules, and verify. 🎉

---

## Environment variables

These are **shared across all servers** — per-server values live in each
server's config row (admin API), not in env.

### Required

| Variable | What it is |
| --- | --- |
| `DISCORD_CLIENT_ID` | OAuth2 Client ID of the **one** shared app |
| `DISCORD_CLIENT_SECRET` | OAuth2 Client Secret |
| `DISCORD_BOT_TOKEN` | Bot token (the bot is invited to each server) |
| `ADMIN_SECRET` | Bearer token guarding the `/admin` API. Unset = admin API disabled |

### Optional (shared)

| Variable | Default | What it is |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | _(none)_ | Default Turnstile site key (a server may override) |
| `TURNSTILE_SECRET_KEY` | _(none)_ | Default Turnstile secret key (a server may override) |
| `TOOL_GUILD_ID` | _(none)_ | Which server `setup.ts` / `post-*.ts` act on (or pass as the first CLI arg) |

A server needs Turnstile keys from **either** the shared defaults above **or**
its own config. With one portal domain, set the shared defaults once and you're
done.

### Legacy (upgrading from the single-guild build only)

If you're upgrading an old single-server deployment, leave its existing env vars
in place: on first boot the shield **auto-seeds a server config row** from them
(and migrates the audit log + stored channel/message IDs), so the server keeps
working and `/` redirects to its `/g/{guildId}`. These are read once for that
migration: `DISCORD_GUILD_ID`, `DISCORD_ROLE_ID`, `VERIFY_SERVER_NAME`,
`VERIFY_REDIRECT_URI`, `VERIFY_PORTAL_URL`, `VERIFY_ALERT_WEBHOOK`,
`VERIFY_RAID_THRESHOLD`, `VERIFY_RAID_WINDOW_MIN`, `VERIFY_ALERT_COOLDOWN_MIN`,
and `DISCORD_*_CHANNEL_ID`. After migrating you can manage everything through the
admin API. New installs should ignore these entirely.

---

## Managing servers

All routes live under `/admin/guilds` and require `Authorization: Bearer
$ADMIN_SECRET`. If `ADMIN_SECRET` is unset the whole API returns `404`. The
Turnstile **secret** is never echoed back (responses report only
`hasTurnstileSecretKey`).

| Method | Route | Does |
| --- | --- | --- |
| `GET` | `/admin/guilds` | List all servers |
| `POST` | `/admin/guilds` | Create a server (`409` if it already exists) |
| `GET` | `/admin/guilds/{id}` | Fetch one server |
| `PUT` | `/admin/guilds/{id}` | Create or replace a server |
| `PATCH` | `/admin/guilds/{id}` | Partial update (only the fields you send) |
| `DELETE` | `/admin/guilds/{id}` | Remove a server |

In `PATCH`, a field sent as `null` **clears** that override (falls back to the
default); fields you omit are left unchanged.

### Config fields

`guildId` and `roleId` are required to create a server. Everything else is
optional; branding fields left unset fall back to `theme.ts`.

| Field | Type | Notes |
| --- | --- | --- |
| `guildId` | string | The Discord server ID (numeric) |
| `roleId` | string | The Verified role ID to grant (numeric) |
| `serverName` | string | Display name on the portal + embeds |
| `disabled` | boolean | When true, the portal/callback treat the server as unknown |
| `brandName` | string | Branding name (defaults to `serverName`, then `theme.ts`) |
| `logoUrl` | string | Square logo (portal card, OG card, rules thumbnail) |
| `accentColor` / `accentColorBright` | hex string | Portal + button accents (e.g. `#5865F2`) |
| `embedColor` | int or `#RRGGBB` | Discord embed stripe color |
| `ogHeadline` / `ogTagline` | string | Social card copy |
| `ogFallbackImage` | string | Shown before the cron first renders the card |
| `rules` | `{name,value}[]` | Rules embed contents (`post-rules.ts`) |
| `about` | `{tagline,description,highlights}` | About card contents (`post-about.ts`) |
| `turnstileSiteKey` / `turnstileSecretKey` | string | Override the shared Turnstile keypair |
| `alertWebhookUrl` | string | Discord webhook for this server's raid alerts |
| `raidThreshold` | number | Successful verifies in the window that trip an alert (default 15) |
| `raidWindowMs` | number | Raid look-back window in ms (default 5 min) |
| `alertCooldownMs` | number | Min gap between alerts in ms (default 15 min) |
| `verifyChannelId` / `rulesChannelId` / `aboutChannelId` / `honeypotChannelId` | string | DMZ channels for the post tools |
| `portalUrl` | string | This server's portal base, `.../g/{guildId}` (Verify button + card image) |
| `redirectUriOverride` | string | Override `/callback` (only for a custom per-server domain) |

```bash
# Re-skin a server later
curl -X PATCH https://<portal>/admin/guilds/111111111111111111 \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -d '{"accentColor":"#43B581","logoUrl":"https://example.com/new.png"}'

# Temporarily pause verification for a server
curl -X PATCH https://<portal>/admin/guilds/111111111111111111 \
  -H "authorization: Bearer $ADMIN_SECRET" -d '{"disabled":true}'

# Remove a server
curl -X DELETE https://<portal>/admin/guilds/111111111111111111 \
  -H "authorization: Bearer $ADMIN_SECRET"
```

---

## Make it yours

`theme.ts` holds the **default** branding for every server — edit it and the
portal page, social card, and Discord embeds re-skin together for any server that
hasn't set its own overrides:

- **`brand.name`** — fallback community name.
- **`brand.logoUrl`** — a square logo (swap the placeholder cat for yours).
- **`brand.accentColor` / `accentColorBright` / `embedColor`** — the accent.
- **`brand.ogHeadline` / `ogTagline`** — the social card copy.
- **`rules`** — the default rules `post-rules.ts` posts.
- **`about`** — the default tagline, description, and highlights.

To brand an **individual** server differently, set the matching fields on its
config via the admin API (`accentColor`, `logoUrl`, `rules`, `about`, …) — those
override the `theme.ts` defaults for that server only. Secrets never live in the
source.

To update what's already posted: change the config (or `theme.ts`) and **re-run
the matching post script** for that server — it edits the live message in place.

---

## Updating messages

When a post tool posts a message, it saves that message's ID to blob storage
(`store.ts`), namespaced by guild. Run the same script again (for the same
server) and it **edits the existing message** instead of posting a duplicate.

How a channel is resolved, in priority order:

1. an explicit ID passed in code (`postRulesMessage(config, { channelId })`),
2. a channel the bot created via `setup.ts` (blob store, per guild),
3. the channel ID on the server's config (`rulesChannelId`, etc.).

So the bot-created channels win automatically, and hand-wired config IDs still
work as a fallback. The post functions also accept `{ messageId }` to target a
specific message, or `{ forceNew: true }` to post a fresh one. If a stored
message was deleted in Discord, the next run notices the `404` and posts a new
one.

> Blob keys used: `captcha_shield_v1_{guildId}_channel_<kind>`,
> `captcha_shield_v1_{guildId}_message_<kind>`, and
> `captcha_shield_v1_{guildId}_category` (one ID per key, so `setup.ts` can post
> all four messages concurrently), plus `verify_og_png_v1_{guildId}` (the cached
> social card).

---

## Adding more servers

Just register another server with the admin API (`POST /admin/guilds`) — no
redeploy, no second val. The one deployment serves them all: each server's
config + branding is keyed by guild id in SQLite, the state nonces / audit log /
raid alerts are scoped per guild, and the single shared bot + OAuth app handles
every server through the one `/callback` redirect URI.

---

## Troubleshooting

The portal turns Discord's API errors into plain-language messages. Common ones:

| Symptom | Cause / fix |
| --- | --- |
| Portal says "This verification link isn't active" | The guild id in the URL isn't registered, or the server is `disabled`. Register it via the admin API. |
| "You're not in the server yet" | The user must **join** the Discord before verifying (this is an already-members gate). |
| "The bot doesn't have permission to grant the role" | Move the **bot's role above** the Verified role, and ensure it has **Manage Roles**. |
| "The verification bot isn't connected to this server" | Wrong `guildId` on the config, or the bot was never invited to that server. |
| "The verified role no longer exists" | Wrong/deleted `roleId` on the config. |
| CAPTCHA never lets you continue | No Turnstile keys for that server (set shared `TURNSTILE_*` env or per-server keys), or the portal domain isn't added to the Turnstile site. |
| Admin API returns `401` | Missing/incorrect `Authorization: Bearer $ADMIN_SECRET`. A `404` on `/admin/*` means `ADMIN_SECRET` isn't set. |
| OAuth "redirect URI mismatch" | The single `/callback` URL in the Developer Portal must match your portal exactly. |
| `/g/{id}/og.png` shows the fallback image | The cron hasn't generated that server's card yet — run `cron.ts` once manually. |

Every attempt (success or failure) is recorded in the `captcha_verify_log_v2`
SQLite table with the `guild_id` and a `detail` column carrying the exact Discord
status/error code, then pruned after 7 days.

---

## Security notes

- OAuth uses the **`identify` scope only** — the shield reads a Discord user ID
  and nothing else.
- State nonces are **single-use, atomically burned, and bound to one server**;
  concurrent callbacks for the same nonce can't both succeed, they expire after
  10 minutes, and a nonce minted for one server can't grant a role in another.
- The admin API compares the bearer token in **constant time** and never echoes
  the Turnstile secret back.
- Turnstile tokens are verified **server-side** against Cloudflare.
- This is an **"already-members" gate**: it stops unverified users from accessing
  gated channels, but Discord roles don't block DMs or member-list visibility on
  their own. [`HARDENING.md`](./HARDENING.md) covers closing those gaps with
  Membership Screening / lockdown.

---

## License

MIT — do whatever you like. A 🐱 of credit to **catalloc** is appreciated but not
required.
