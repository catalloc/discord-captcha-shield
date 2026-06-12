# 🐱 Discord CAPTCHA Shield

A drop-in, self-hostable **CAPTCHA + Discord OAuth verification gate** for your
Discord server — built to run on [Val Town](https://val.town). New members solve
a Cloudflare Turnstile CAPTCHA, authorize with Discord, and a bot automatically
grants them your **Verified** role. Bots and raid scripts don't get in.

> Made by **catalloc**. Remix it, re-skin it, ship it. The whole thing is one
> small Val Town project with no build step and no servers to run.

<p align="center"><img src="https://placecats.com/1200/630" alt="Discord CAPTCHA Shield" width="640" /></p>

---

## What you get

- **A branded portal page** (`/`) — CAPTCHA → "Continue with Discord" → done.
- **One-time, single-use state nonces** (SQLite) bound to a passed CAPTCHA, so a
  callback can't be replayed or forged.
- **Automatic role grant** via a bot using only the `identify` OAuth scope (the
  shield never sees a password and never reads message content).
- **Raid alerts** — a Discord webhook ping when an abnormal number of *successful*
  verifications land in a short window (the farmed-account pattern Turnstile
  can't catch).
- **A dynamic social card** (`/og.png`) rendered with satori + resvg and cached.
- **One-click DMZ bootstrap** (`setup.ts`) — the bot creates the `#about`,
  `#rules`, `#verify`, and `#do-not-post` channels (read-only, honeypot open)
  and posts every message into them.
- **Editable messages** — re-running a post tool updates the existing message in
  place instead of duplicating it (channel + message IDs are kept in blob).
- **An audit log** of every attempt, auto-pruned after 7 days.

## How it works

```
Visitor                 Portal (this val)              Discord
  │  GET /  ───────────────▶  render CAPTCHA page
  │  solve Turnstile
  │  POST /start ─────────▶  verify token w/ Cloudflare
  │                          mint one-time state nonce (SQLite)
  │  ◀──────────── OAuth URL
  │  authorize (identify) ──────────────────────────▶  consent screen
  │  GET /callback?code&state ◀──────────────────────  redirect back
  │                          burn nonce, exchange code,
  │                          read user id, PUT role ──▶  role granted ✅
  │  ◀──────────── "Verified" result page
```

Roles gate **channel access**. Lock `@everyone` down to a single `#verify`
channel and grant the rest to the Verified role — see
[`HARDENING.md`](./HARDENING.md) for the full lockdown + the limits of this model
(DMs / member-list visibility).

---

## Files

```
http.ts          # HTTP trigger — the portal + OAuth routes (set as HTTP val)
cron.ts          # Cron trigger — daily cleanup + OG card refresh
mod.ts           # All verification logic (Turnstile, OAuth, role grant, UI)
og.ts            # Dynamic /og.png social card generator
config.ts        # Reads env vars into config (edit nothing — set env instead)
theme.ts         # 🎨 Branding: colors, logo, copy, rules — EDIT THIS to make it yours
store.ts         # Blob-backed store of created channel + posted message IDs
channels.ts      # Creates the DMZ channels (used by setup.ts)
setup.ts         # Run once — bot creates the DMZ channels AND posts every message
post-verify.ts   # Run — bot posts (or updates) the Verify button
post-rules.ts    # Run — bot posts (or updates) the rules embed
post-about.ts    # Run — bot posts (or updates) the "About the community" card
post-honeypot.ts # Run — bot posts (or updates) the honeypot "do not post" trap
deno.json        # Val Town / Deno config
```

---

## Installation

You'll need ~15 minutes, a Discord server you administer, and free Cloudflare +
Val Town accounts.

### 1. Create a Discord application & bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   → **New Application**.
2. **OAuth2** tab → copy the **Client ID** and **Client Secret**.
3. **Bot** tab → **Add Bot** → **Reset Token** and copy the **Bot Token**.
   - The default (non-privileged) intents are fine — this shield never reads
     message content or the member list.
4. **Invite the bot** to your server with the `bot` scope and these permissions:

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

   **Want the bot to auto-create the DMZ channels** via `setup.ts` (step 6,
   Option A)? Also grant **Manage Channels** — use `permissions=268454928`
   instead. If you'll make the channels yourself, the shield never needs it.

### 2. Create the Verified role & set up channels

1. Create a **Verified** role. Copy its ID (enable *Developer Mode* in Discord
   → User Settings → Advanced, then right-click the role → **Copy ID**).
2. **Important — role hierarchy:** drag the **bot's own role above the Verified
   role** in Server Settings → Roles. A bot can only assign roles *below* its
   highest role.
3. Right-click your server → **Copy Server ID** (that's the **Guild ID**).
4. (Recommended) Lock the server down: deny `@everyone` **View Channel**
   everywhere except a single `#verify` channel; grant the real channels to the
   Verified role. See [`HARDENING.md`](./HARDENING.md).

### 3. Get a Cloudflare Turnstile keypair (free)

1. Cloudflare Dashboard → **Turnstile** → **Add site**.
2. Add the domain you'll serve the portal from (your val's domain — e.g.
   `your-val.val.run`, or a custom domain). You can add `localhost` for testing.
3. Copy the **Site Key** and **Secret Key**.

### 4. Create the val on Val Town

1. **Remix this template** into your own Val Town project (or create a new
   project and copy these files in).
2. Set the triggers:
   - **`http.ts`** → make it an **HTTP** val. Note its URL — that's your portal.
   - **`cron.ts`** → make it a **Cron** val on a daily schedule (e.g. `0 6 * * *`).
3. Add the environment variables below (Val Town → your project →
   **Environment Variables**).

### 5. Configure the OAuth redirect

Back in the Discord Developer Portal → **OAuth2** → **Redirects**, add:

```
https://<your-portal-domain>/callback
```

This must match exactly. If you use a custom domain, set `VERIFY_REDIRECT_URI`
to the full callback URL (see below).

### 6. Set up the DMZ & post the messages

The **DMZ** is the handful of channels an unverified member can see. You have two
ways to set it up — pick one.

**Option A — let the bot build it (one click).** Grant the bot **Manage
Channels** (the invite URL in step 1 with `permissions=268454928` includes it),
then open **`setup.ts`** and hit **Run**. It creates a `Welcome` category with
`#about`, `#rules`, `#verify`, and `#do-not-post` (read-only to `@everyone`,
honeypot left open), then posts every message into them. Channel + message IDs
are saved to blob storage, so you never have to copy an ID by hand.

**Option B — use your own channels.** Create the channels yourself, set the
`DISCORD_*_CHANNEL_ID` env vars, and run the post scripts individually:

| Script | Posts | Channel env var |
| --- | --- | --- |
| `post-about.ts` | "About the community" card (+ Verify button) | `DISCORD_ABOUT_CHANNEL_ID` |
| `post-rules.ts` | The rules embed | `DISCORD_RULES_CHANNEL_ID` |
| `post-verify.ts` | The Verify button | `DISCORD_VERIFY_CHANNEL_ID` |
| `post-honeypot.ts` | A "do not post" trap that outs spam bots | `DISCORD_HONEYPOT_CHANNEL_ID` |

Either way: **re-running a post script edits its message in place** — it doesn't
post a duplicate. See [Updating messages](#updating-messages) below. Done — new
members can now read what you're about, see the rules, and verify. 🎉

---

## Environment variables

### Required

| Variable | What it is |
| --- | --- |
| `DISCORD_CLIENT_ID` | OAuth2 Client ID (Developer Portal → OAuth2) |
| `DISCORD_CLIENT_SECRET` | OAuth2 Client Secret |
| `DISCORD_BOT_TOKEN` | Bot token (Developer Portal → Bot) |
| `DISCORD_GUILD_ID` | Your server ID |
| `DISCORD_ROLE_ID` | The Verified role ID to grant |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key (public) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret key |

### Optional

| Variable | Default | What it is |
| --- | --- | --- |
| `VERIFY_SERVER_NAME` | brand name in `theme.ts` | Display name on the portal & embeds |
| `VERIFY_REDIRECT_URI` | `${origin}/callback` | Override callback (use for custom domains) |
| `VERIFY_PORTAL_URL` | derived from redirect | Public base URL (Verify button + card image) |
| `VERIFY_ALERT_WEBHOOK` | _(off)_ | Discord webhook URL for raid alerts |
| `VERIFY_RAID_THRESHOLD` | `15` | Successful verifies in the window that trip an alert |
| `VERIFY_RAID_WINDOW_MIN` | `5` | Raid look-back window (minutes) |
| `VERIFY_ALERT_COOLDOWN_MIN` | `15` | Minimum gap between raid alerts (minutes) |
| `DISCORD_VERIFY_CHANNEL_ID` | — | Channel for the Verify button (`post-verify.ts`) |
| `DISCORD_RULES_CHANNEL_ID` | — | Channel for the rules embed (`post-rules.ts`) |
| `DISCORD_ABOUT_CHANNEL_ID` | — | DMZ channel for the About card (`post-about.ts`) |
| `DISCORD_HONEYPOT_CHANNEL_ID` | — | Trap channel (`post-honeypot.ts`) |

Channel IDs accept a raw numeric ID, a channel link, or a `#mention`.

---

## Make it yours

Everything visual lives in **`theme.ts`** — edit it and the portal page, the
social card, and every Discord embed re-skin together:

- **`brand.name`** — your community name.
- **`brand.logoUrl`** — a square logo (swap the placeholder cat for yours).
- **`brand.accentColor` / `accentColorBright` / `embedColor`** — your accent.
- **`brand.ogHeadline` / `ogTagline`** — the social card copy.
- **`rules`** — the array of rules `post-rules.ts` posts.
- **`about`** — the tagline, description, and highlights `post-about.ts` posts.

No code changes needed for any of it. Secrets and server-specific IDs stay in
environment variables, never in the source.

To update what's already posted: edit `theme.ts` (or `rules` / `about`) and
**re-run the matching post script** — it edits the live message in place.

---

## Updating messages

When a post tool posts a message, it saves that message's ID to blob storage
(`store.ts`). Run the same script again and it **edits the existing message**
instead of posting a duplicate — so fixing a typo in your rules or re-theming
the About card is just an edit + re-run.

How a channel is resolved, in priority order:

1. an explicit ID passed in code (`postRulesMessage(config, { channelId })`),
2. a channel the bot created via `setup.ts` (blob store),
3. the `DISCORD_*_CHANNEL_ID` env var.

So the bot-created channels win automatically, and hand-wired env IDs still work
as a fallback. The post functions also accept `{ messageId }` to target a
specific message, or `{ forceNew: true }` to post a fresh one (e.g. after you
manually deleted the old message). If a stored message was deleted in Discord,
the next run notices the `404` and posts a new one.

> Blob keys used: `captcha_shield_v1_channel_<kind>`,
> `captcha_shield_v1_message_<kind>`, and `captcha_shield_v1_category` (one ID
> per key, so `setup.ts` can post all four messages concurrently), plus
> `verify_og_png_v1` (the cached social card).

---

## Running a second server

Don't add a second entry point inside one val — the SQLite tables aren't
namespaced per guild, so two instances in the same val would share nonces, logs,
and alert state. Instead **clone the whole val** and give the clone its own env.
Each Val Town project gets its own isolated SQLite database, so the copies never
collide.

---

## Troubleshooting

The portal turns Discord's API errors into plain-language messages. Common ones:

| Symptom | Cause / fix |
| --- | --- |
| "You're not in the server yet" | The user must **join** the Discord before verifying (this is an already-members gate). |
| "The bot doesn't have permission to grant the role" | Move the **bot's role above** the Verified role, and ensure it has **Manage Roles**. |
| "The verification bot isn't connected to this server" | Wrong `DISCORD_GUILD_ID`, or the bot was never invited. |
| "The verified role no longer exists" | Wrong/deleted `DISCORD_ROLE_ID`. |
| CAPTCHA never lets you continue | Wrong `TURNSTILE_SITE_KEY`, or the portal domain isn't added to the Turnstile site. |
| OAuth "redirect URI mismatch" | The `/callback` URL in the Developer Portal must match your portal exactly. |
| `/og.png` shows the fallback image | The cron hasn't generated the card yet — run `cron.ts` once manually. |

Every attempt (success or failure) is recorded in the `captcha_verify_log`
SQLite table with a `detail` column carrying the exact Discord status/error code,
then pruned after 7 days.

---

## Security notes

- OAuth uses the **`identify` scope only** — the shield reads a Discord user ID
  and nothing else.
- State nonces are **single-use and atomically burned**; concurrent callbacks
  for the same nonce can't both succeed, and they expire after 10 minutes.
- Turnstile tokens are verified **server-side** against Cloudflare.
- This is an **"already-members" gate**: it stops unverified users from accessing
  gated channels, but Discord roles don't block DMs or member-list visibility on
  their own. [`HARDENING.md`](./HARDENING.md) covers closing those gaps with
  Membership Screening / lockdown.

---

## License

MIT — do whatever you like. A 🐱 of credit to **catalloc** is appreciated but not
required.
