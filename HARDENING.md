# Verification Hardening — closing the gaps

The CAPTCHA shield is an **"already-members" gate**, and that model has known
limits. This doc explains exactly what it does and does not stop, and the options
for tightening it. None of this is required to run the shield — it works as-is —
but read it before relying on it as your only line of defense.

## What the shield does

A user joins the Discord → solves the CAPTCHA → Discord OAuth → the bot grants
the **Verified** role, which *unlocks* channels.

- **Stops:** posting/participating in channels gated behind the Verified role
  (assuming `@everyone` is locked down).
- **Does NOT stop (the gap):** a member who has *joined but not verified* can
  still (a) appear in / read the **member list** of any channel they can view,
  and (b) **DM** other members they share the server with.

Roles gate *channel access*, not DMs or member-list visibility. Discord has **no
"cannot DM" permission** — DMs are allowed between users who share a server
(subject to each user's privacy settings + the server DM spam filter).

## What actually restricts a joined user

Only two things meaningfully limit a joined-but-unverified user:

1. **Membership Screening "pending" state** — Discord's native gate. New joins
   are "pending" until they complete screening; pending members **cannot DM
   other members or interact**. This is the real lever for the DM/member-list
   vector.
2. **Hard channel-permission lockdown** — `@everyone` can view only a single
   `#verify` channel, so member-list exposure is limited to who can see that one
   channel. Still does not block DMs.

## Options (with tradeoffs)

### A. Server-config lockdown — do this regardless (little/no code)
- `@everyone`: deny **View Channel** everywhere except one `#verify` channel;
  strip most perms. Verified role grants View on the real channels.
- Stack native levers: raise **Verification Level** (Medium/High), enable
  **AutoMod** + **DM spam filter**, enable **Membership Screening** +
  **Onboarding**.
- Limits member-list exposure; does not by itself stop DMs.

### B. Membership Screening (the real DM blocker)
- New joins are "pending" until they pass screening → can't DM/interact.
- **Caveat:** native screening completion is "agree to the rules" (a client
  gesture a determined bot can automate), so it isn't bot-proof on its own. Pair
  it with the CAPTCHA: screening blocks DMs, the CAPTCHA blocks bots.

### C. Gateway bot for join handling (quarantine + auto-kick)
- React to `GUILD_MEMBER_ADD`: assign a **Quarantine** role (View denied
  everywhere except `#verify`) and auto-kick if unverified within N minutes.
- Quarantine limits member-list exposure and the auto-kick shrinks the DM
  window, but does **not** fully block DMs (mutual server).
- **Cost:** needs a persistent gateway (WebSocket) connection. **Val Town is
  serverless and not suited to an always-on gateway.** You'd need a separate
  always-on host (a small VPS, Fly/Railway, a Cloudflare Durable Object with a
  gateway lib, or a hosted bot framework). The CAPTCHA portal can stay on Val
  Town as the unlock step. Requires the **GUILD_MEMBERS** privileged intent.

### D. Combine (recommended target)
- Membership Screening / Onboarding holds joiners pending (blocks DMs +
  member-list) and routes them to the CAPTCHA portal; the bot grants Verified
  after CAPTCHA.

## A quick win available now

On successful verify, also **remove** an "Unverified"/"Quarantine" role (not just
add Verified): add an `unverifiedRoleId` field to the per-server config (a column
in `captcha_guilds` + the admin API, alongside `roleId`) and a `DELETE
/guilds/{guild}/members/{user}/roles/{roleId}` call on success in `mod.ts`. Keep
it per-server, not an env var, so each shielded server can use its own quarantine
role. (Auto-*assigning* that role on join still needs a gateway bot or an
Onboarding default role.)
