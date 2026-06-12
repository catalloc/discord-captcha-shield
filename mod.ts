/**
 * Discord CAPTCHA Shield — CAPTCHA + Discord OAuth verification module.
 *
 * A self-contained verification gate for a Discord server:
 *   1. Visitor solves a Cloudflare Turnstile CAPTCHA.
 *   2. Server verifies the Turnstile token and mints a one-time, short-lived
 *      state nonce (SQLite) bound to that passed challenge.
 *   3. Visitor authorizes via Discord OAuth2 (identify scope only).
 *   4. On callback the nonce is validated + burned, identity is read, and the
 *      configured bot grants the verified role to the (already-joined) member.
 *
 * Config-driven: everything visual lives in ./theme.ts, everything secret comes
 * from env (see ./config.ts). To shield a second Discord, clone the whole val
 * and set that copy's env — its project-scoped SQLite keeps storage isolated.
 */

import { sqlite } from "https://esm.town/v/std/sqlite";
import { about, brand, portalCss, rules } from "./theme.ts";
import {
  type ChannelKind,
  getChannel,
  getMessage,
  rememberChannel,
  rememberMessage,
} from "./store.ts";

// ========================================
// CONSTANTS
// ========================================

const DISCORD_API = "https://discord.com/api/v10";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const STATE_TTL_MS = 10 * 60 * 1000; // verification link valid for 10 minutes

const STATES_TABLE = "captcha_verify_states";
const LOG_TABLE = "captcha_verify_log";
const ALERTS_TABLE = "captcha_verify_alerts";

// Raid detection: alert when an abnormal number of *successful* verifications
// land within a short window (the pattern Turnstile can't catch — farmed
// accounts solving real CAPTCHAs). Debounced so we send at most one alert per
// cooldown. These are defaults; override per-deployment via VerifyConfig.
const DEFAULT_RAID_WINDOW_MS = 5 * 60 * 1000; // look back 5 minutes
const DEFAULT_RAID_THRESHOLD = 15; // successes within window that trips alert
const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000; // min gap between alerts

// ========================================
// TYPES
// ========================================

export interface VerifyConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  guildId: string;
  roleId: string;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  /** Display name shown on the portal (defaults to the brand name). */
  serverName?: string;
  /** Override the derived `${origin}/callback` (use for custom domains). */
  redirectUriOverride?: string;
  /** Optional Discord webhook URL for raid alerts. No alerts if unset. */
  alertWebhookUrl?: string;
  /** Successful verifications within the window that trip a raid alert. */
  raidThreshold?: number;
  /** Raid-detection look-back window, in milliseconds. */
  raidWindowMs?: number;
  /** Minimum gap between raid alerts, in milliseconds. */
  alertCooldownMs?: number;
  /** Channel the bot posts the verification message into (for postVerifyMessage). */
  verifyChannelId?: string;
  /** Public base URL of the portal (for the Verify button + card image). */
  portalUrl?: string;
  /** Channel the bot posts the rules embed into (for postRulesMessage). */
  rulesChannelId?: string;
  /** Honeypot/trap channel the bot posts the "do not post" warning into. */
  honeypotChannelId?: string;
  /** DMZ channel the bot posts the "about the community" embed into. */
  aboutChannelId?: string;
}

interface DiscordUser {
  id: string;
  username?: string;
}

/** Display name for this deployment: env override, else the brand default. */
function displayName(config: VerifyConfig): string {
  return config.serverName ?? brand.name;
}

// ========================================
// DATABASE
// ========================================

let tablesInitialized = false;

async function ensureTables(): Promise<void> {
  if (tablesInitialized) return;

  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${STATES_TABLE} (
      state TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);

  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      discord_username TEXT,
      created_at INTEGER NOT NULL,
      success INTEGER NOT NULL,
      detail TEXT
    )
  `);

  // Keeps the raid-detection COUNT (success + recent window) an index seek.
  await sqlite.execute(`
    CREATE INDEX IF NOT EXISTS idx_${LOG_TABLE}_success_created
    ON ${LOG_TABLE} (success, created_at)
  `);

  // Debounce state for alerts (one row per alert kind).
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${ALERTS_TABLE} (
      kind TEXT PRIMARY KEY,
      last_alert_at INTEGER NOT NULL
    )
  `);

  tablesInitialized = true;
}

/** Delete used or expired nonces. Cheap because the table only ever holds
 *  in-flight verifications (we prune on every mint). Best-effort. */
async function pruneStates(): Promise<void> {
  try {
    await sqlite.execute({
      sql: `DELETE FROM ${STATES_TABLE} WHERE used = 1 OR created_at < ?`,
      args: [Date.now() - STATE_TTL_MS],
    });
  } catch {
    // pruning is best-effort; never block a verification on it
  }
}

/** Mint a one-time state nonce. Only called after Turnstile has passed. */
async function mintState(): Promise<string> {
  await ensureTables();
  await pruneStates();
  const state = crypto.randomUUID();
  await sqlite.execute({
    sql:
      `INSERT INTO ${STATES_TABLE} (state, created_at, used) VALUES (?, ?, 0)`,
    args: [state, Date.now()],
  });
  return state;
}

/** Validate and atomically burn a state nonce. Returns a reason on failure. */
async function consumeState(
  state: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await ensureTables();
  const now = Date.now();

  // Atomic single-use: only the request that flips `used` from 0->1 on a
  // still-valid row wins. Concurrent callbacks for the same state can't both
  // succeed (no check-then-act race).
  const burn = await sqlite.execute({
    sql:
      `UPDATE ${STATES_TABLE} SET used = 1 WHERE state = ? AND used = 0 AND created_at > ?`,
    args: [state, now - STATE_TTL_MS],
  });
  if ((burn.rowsAffected || 0) === 1) {
    return { ok: true };
  }

  // The burn didn't take — figure out why for a helpful message (rare path).
  const res = await sqlite.execute({
    sql: `SELECT used, created_at FROM ${STATES_TABLE} WHERE state = ?`,
    args: [state],
  });
  if (!res.rows || res.rows.length === 0) {
    return { ok: false, reason: "Invalid session. Please start over." };
  }
  if (Number(res.rows[0][0])) {
    return { ok: false, reason: "This verification link was already used." };
  }
  return { ok: false, reason: "Your session expired. Please start over." };
}

async function logVerification(
  user: DiscordUser,
  success: boolean,
  detail: string,
): Promise<void> {
  try {
    await ensureTables();
    await sqlite.execute({
      sql:
        `INSERT INTO ${LOG_TABLE} (discord_user_id, discord_username, created_at, success, detail) VALUES (?, ?, ?, ?, ?)`,
      args: [user.id, user.username ?? null, Date.now(), success ? 1 : 0, detail],
    });
  } catch {
    // logging is best-effort
  }
}

/**
 * Prune ephemeral nonces and age out the audit log. Called by the cron.
 * Returns how many rows were deleted from each table.
 */
export async function cleanupVerifyData(
  logRetentionDays: number,
): Promise<{ states: number; logs: number }> {
  await ensureTables();
  const states = await sqlite.execute({
    sql: `DELETE FROM ${STATES_TABLE} WHERE used = 1 OR created_at < ?`,
    args: [Date.now() - STATE_TTL_MS],
  });
  const logs = await sqlite.execute({
    sql: `DELETE FROM ${LOG_TABLE} WHERE created_at < ?`,
    args: [Date.now() - logRetentionDays * 24 * 60 * 60 * 1000],
  });
  return { states: states.rowsAffected || 0, logs: logs.rowsAffected || 0 };
}

// ========================================
// DISCORD + TURNSTILE
// ========================================

async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
): Promise<boolean> {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);

  const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
  const data = await res.json().catch(() => ({ success: false }));
  return data.success === true;
}

async function exchangeCode(
  config: VerifyConfig,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const form = new URLSearchParams();
  form.set("client_id", config.clientId);
  form.set("client_secret", config.clientSecret);
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.access_token as string) ?? null;
}

async function fetchDiscordUser(
  accessToken: string,
): Promise<DiscordUser | null> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return await res.json() as DiscordUser;
}

/**
 * Grant the verified role to an existing guild member.
 * Returns the HTTP status and, on failure, the Discord error code so callers
 * can distinguish "user not in guild" from configuration problems.
 */
async function grantRole(
  config: VerifyConfig,
  userId: string,
): Promise<{ status: number; body: string; code?: number }> {
  const res = await fetch(
    `${DISCORD_API}/guilds/${config.guildId}/members/${userId}/roles/${config.roleId}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bot ${config.botToken}`,
        "x-audit-log-reason": "Passed CAPTCHA verification portal",
      },
    },
  );
  if (res.status === 204) return { status: 204, body: "" };
  const body = await res.text();
  let code: number | undefined;
  try {
    code = JSON.parse(body)?.code;
  } catch {
    // non-JSON error body
  }
  return { status: res.status, body, code };
}

/**
 * Fire a Discord webhook alert if the rate of successful verifications spikes
 * past RAID_THRESHOLD within RAID_WINDOW_MS. Debounced via an atomic update so
 * only one request per ALERT_COOLDOWN_MS sends. Best-effort and never blocks
 * the verifying user's response. No-op when no webhook is configured.
 */
async function maybeAlertRaid(
  config: VerifyConfig,
  serverName: string,
): Promise<void> {
  if (!config.alertWebhookUrl) return;
  const threshold = config.raidThreshold ?? DEFAULT_RAID_THRESHOLD;
  const windowMs = config.raidWindowMs ?? DEFAULT_RAID_WINDOW_MS;
  const cooldownMs = config.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  try {
    const now = Date.now();
    const countRes = await sqlite.execute({
      sql:
        `SELECT COUNT(*) FROM ${LOG_TABLE} WHERE success = 1 AND created_at > ?`,
      args: [now - windowMs],
    });
    const count = Number(countRes.rows?.[0]?.[0] ?? 0);
    if (count < threshold) return;

    // Atomic debounce: ensure a row exists, then only the request that moves
    // last_alert_at past the cooldown actually sends.
    await sqlite.execute({
      sql:
        `INSERT OR IGNORE INTO ${ALERTS_TABLE} (kind, last_alert_at) VALUES ('raid', 0)`,
      args: [],
    });
    const claimed = await sqlite.execute({
      sql:
        `UPDATE ${ALERTS_TABLE} SET last_alert_at = ? WHERE kind = 'raid' AND last_alert_at < ?`,
      args: [now, now - cooldownMs],
    });
    if ((claimed.rowsAffected || 0) !== 1) return;

    await sendDiscordAlert(config.alertWebhookUrl, serverName, count, windowMs, threshold);
  } catch {
    // alerting is best-effort
  }
}

async function sendDiscordAlert(
  webhookUrl: string,
  serverName: string,
  count: number,
  windowMs: number,
  threshold: number,
): Promise<void> {
  const windowMin = Math.round(windowMs / 60000);
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Verification Shield",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "⚠️ Possible verification raid",
        description:
          `**${count}** accounts verified in the last **${windowMin} min** on **${serverName}** — above the alert threshold of ${threshold}. This may be a coordinated raid using farmed accounts (Turnstile can't catch those). Consider pausing verification or tightening server join settings.`,
        color: brand.embedColor,
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

/**
 * Have the bot post the verification message (branded embed + a link "Verify"
 * button) into the configured channel. Triggered manually (post-verify.ts),
 * not on a schedule. The bot needs Send Messages + Embed Links in that channel.
 */
export async function postVerifyMessage(
  config: VerifyConfig,
  opts: PostOpts = {},
): Promise<{ ok: boolean; detail: string }> {
  const channelId = await resolveChannel("verify", config, opts.channelId);
  if (!channelId) {
    return {
      ok: false,
      detail:
        "No verify channel. Run setup.ts to create the DMZ channels, or set DISCORD_VERIFY_CHANNEL_ID (numeric ID, link, or #mention).",
    };
  }
  if (!config.portalUrl) {
    return {
      ok: false,
      detail: "Set VERIFY_PORTAL_URL (or VERIFY_REDIRECT_URI) to the portal URL.",
    };
  }
  const serverName = displayName(config);
  const base = config.portalUrl.replace(/\/+$/, "");

  const payload = {
    embeds: [{
      title: "Server Verification",
      description:
        `Welcome to **${serverName}**! To keep the community safe from bots and raids, new members verify before getting access.\n\nClick **Verify** below, complete a quick CAPTCHA, and your role is granted automatically.`,
      color: brand.embedColor,
      image: { url: `${base}/og.png` },
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: "Verify", url: base }],
    }],
    allowed_mentions: { parse: [] },
  };

  return await upsertMessage("verify", channelId, config, payload, opts);
}

/**
 * Have the bot post the server rules as a branded embed into the configured
 * channel. Triggered manually (post-rules.ts). The bot needs Send Messages
 * + Embed Links in that channel.
 */
export async function postRulesMessage(
  config: VerifyConfig,
  opts: PostOpts = {},
): Promise<{ ok: boolean; detail: string }> {
  const channelId = await resolveChannel("rules", config, opts.channelId);
  if (!channelId) {
    return {
      ok: false,
      detail:
        "No rules channel. Run setup.ts to create the DMZ channels, or set DISCORD_RULES_CHANNEL_ID (numeric ID, link, or #mention).",
    };
  }

  const serverName = displayName(config);

  const payload = {
    embeds: [{
      title: "Discord Rules",
      description:
        "Our hope is that we rarely need to enforce these, but it's to everyone's benefit to be clear about who we are and what we expect. The mod team will enforce these rules as necessary.",
      color: brand.embedColor,
      thumbnail: { url: brand.logoUrl },
      fields: rules,
      footer: { text: serverName },
    }],
    allowed_mentions: { parse: [] },
  };

  return await upsertMessage("rules", channelId, config, payload, opts);
}

/**
 * Have the bot post the "About the community" embed into a DMZ channel — one an
 * unverified member can see — so newcomers know what they're joining before
 * they verify. Triggered manually (post-about.ts). Pulls links to the verify +
 * rules channels (as #mentions) when those IDs are set, and adds a Verify
 * button when VERIFY_PORTAL_URL is configured. The bot needs Send Messages +
 * Embed Links in that channel.
 */
export async function postAboutMessage(
  config: VerifyConfig,
  opts: PostOpts = {},
): Promise<{ ok: boolean; detail: string }> {
  const channelId = await resolveChannel("about", config, opts.channelId);
  if (!channelId) {
    return {
      ok: false,
      detail:
        "No about channel. Run setup.ts to create the DMZ channels, or set DISCORD_ABOUT_CHANNEL_ID (numeric ID, link, or #mention).",
    };
  }
  const serverName = displayName(config);
  const verifyId = await resolveChannel("verify", config);
  const rulesId = await resolveChannel("rules", config);

  // Point newcomers at the next step. Prefer channel mentions; fall back to a
  // plain instruction when those IDs aren't configured.
  const pointers: string[] = [];
  if (verifyId) pointers.push(`Ready? Verify in <#${verifyId}> to unlock the server.`);
  if (rulesId) pointers.push(`Read the rules in <#${rulesId}> first.`);

  const fields = [...about.highlights];
  if (pointers.length) {
    fields.push({ name: "👉 Getting in", value: pointers.join("\n") });
  }

  const embed: Record<string, unknown> = {
    title: `About ${serverName}`,
    description: `*${about.tagline}*\n\n${about.description}`,
    color: brand.embedColor,
    thumbnail: { url: brand.logoUrl },
    fields,
    footer: { text: serverName },
  };

  const payload: Record<string, unknown> = {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
  // When we know the portal URL, give the About card its own Verify button so
  // the DMZ has a one-click path in.
  if (config.portalUrl) {
    const base = config.portalUrl.replace(/\/+$/, "");
    payload.components = [{
      type: 1,
      components: [{ type: 2, style: 5, label: "Verify", url: base }],
    }];
  }

  return await upsertMessage("about", channelId, config, payload, opts);
}

// ========================================
// CHANNEL + MESSAGE RESOLUTION
// ========================================

export interface PostOpts {
  /** Override the resolved channel (raw ID, link, or #mention). */
  channelId?: string;
  /** Edit this specific message instead of the stored one. */
  messageId?: string;
  /** Always post a new message, ignoring any stored message ID. */
  forceNew?: boolean;
}

/** Extract a numeric channel ID from a raw ID, a #mention, or a channel link. */
export function parseChannelId(raw: string | undefined): string {
  if (!raw) return "";
  const t = raw.trim();
  const m = t.match(/channels\/\d+\/(\d+)/);
  return m ? m[1] : t.replace(/\D/g, "");
}

/** The env-derived channel field on config for a given DMZ message kind. */
function channelEnvField(
  config: VerifyConfig,
  kind: ChannelKind,
): string | undefined {
  switch (kind) {
    case "about":
      return config.aboutChannelId;
    case "rules":
      return config.rulesChannelId;
    case "verify":
      return config.verifyChannelId;
    case "honeypot":
      return config.honeypotChannelId;
  }
}

/**
 * Resolve a DMZ channel ID in priority order:
 *   1. an explicit override (e.g. opts.channelId)
 *   2. a channel the bot created (blob store)
 *   3. the env var (config field)
 * Returns "" when none is known.
 */
export async function resolveChannel(
  kind: ChannelKind,
  config: VerifyConfig,
  explicit?: string,
): Promise<string> {
  const direct = parseChannelId(explicit);
  if (direct) return direct;
  const stored = await getChannel(kind);
  if (stored) return stored;
  return parseChannelId(channelEnvField(config, kind));
}

/**
 * Post `payload` into `channelId`, or EDIT the message we last posted for this
 * kind — so re-running a post tool updates in place instead of duplicating.
 * Which message to edit: opts.messageId, else the stored id (unless
 * opts.forceNew). A stored-but-deleted message (404) falls back to a fresh
 * post. Remembers the resulting channel + message IDs in the blob store.
 */
async function upsertMessage(
  kind: ChannelKind,
  channelId: string,
  config: VerifyConfig,
  payload: Record<string, unknown>,
  opts: PostOpts,
): Promise<{ ok: boolean; detail: string }> {
  const headers = {
    authorization: `Bot ${config.botToken}`,
    "content-type": "application/json",
  };
  const targetId = opts.messageId ??
    (opts.forceNew ? undefined : await getMessage(kind));

  if (targetId) {
    const res = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages/${targetId}`,
      { method: "PATCH", headers, body: JSON.stringify(payload) },
    );
    if (res.ok) {
      await rememberMessage(kind, targetId);
      await rememberChannel(kind, channelId);
      return {
        ok: true,
        detail: `updated message ${targetId} in channel ${channelId}`,
      };
    }
    // A 404 means the stored message was deleted — fall through to a fresh post.
    if (res.status !== 404) {
      return {
        ok: false,
        detail:
          `Discord ${res.status} editing message ${targetId} in channel ${channelId}: ${(await res.text()).slice(0, 200)}`,
      };
    }
  }

  const res = await fetch(
    `${DISCORD_API}/channels/${channelId}/messages`,
    { method: "POST", headers, body: JSON.stringify(payload) },
  );
  if (res.ok) {
    const msg = await res.json().catch(() => ({} as { id?: string }));
    if (msg?.id) await rememberMessage(kind, String(msg.id));
    await rememberChannel(kind, channelId);
    return {
      ok: true,
      detail: `posted to channel ${channelId}${msg?.id ? ` (message ${msg.id})` : ""}`,
    };
  }
  return {
    ok: false,
    detail:
      `Discord ${res.status} posting to channel ${channelId}: ${(await res.text()).slice(0, 200)} — check the ID is correct and the bot can view + post in that channel.`,
  };
}

/**
 * Have the bot post a "do not post here" warning into a honeypot/trap channel,
 * pointing legit users to verification (and the rules). Bots that auto-spam
 * every channel reveal themselves here. Triggered manually (post-honeypot.ts).
 * The verify/rules links use channel mentions resolved from the existing
 * DISCORD_VERIFY_CHANNEL_ID / DISCORD_RULES_CHANNEL_ID.
 */
export async function postHoneypotMessage(
  config: VerifyConfig,
  opts: PostOpts = {},
): Promise<{ ok: boolean; detail: string }> {
  const channelId = await resolveChannel("honeypot", config, opts.channelId);
  if (!channelId) {
    return {
      ok: false,
      detail:
        "No honeypot channel. Run setup.ts to create the DMZ channels, or set DISCORD_HONEYPOT_CHANNEL_ID (numeric ID, link, or #mention).",
    };
  }
  const verifyId = await resolveChannel("verify", config);
  const rulesId = await resolveChannel("rules", config);
  const serverName = displayName(config);

  const lines = ["**Please do not post in this channel.**", ""];
  lines.push(
    verifyId
      ? `To unlock ${serverName}, head to <#${verifyId}> and complete verification.`
      : `To unlock ${serverName}, complete verification in the verification channel.`,
  );
  if (rulesId) lines.push(`New here? Read the rules in <#${rulesId}>.`);
  lines.push("", "This channel is monitored — anything posted here may be treated as spam.");

  const payload = {
    embeds: [{
      title: "Do Not Post In This Channel",
      description: lines.join("\n"),
      color: brand.embedColor,
      footer: { text: serverName },
    }],
    allowed_mentions: { parse: [] },
  };

  return await upsertMessage("honeypot", channelId, config, payload, opts);
}

// ========================================
// RENDERING
// ========================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DISCORD_GLYPH =
  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.3.5a14 14 0 0 1 4.3 1.4A13.6 13.6 0 0 0 4.6 4.9 13.7 13.7 0 0 1 8.9 3.5L8.6 3a19.8 19.8 0 0 0-4.9 1.4C1.1 8.3.5 12.1.7 15.8a19.9 19.9 0 0 0 6 3l.8-1.1c-1-.4-2-.9-2.8-1.5l.7-.5a14.2 14.2 0 0 0 12.2 0l.7.5c-.9.6-1.8 1.1-2.8 1.5l.8 1.1a19.8 19.8 0 0 0 6-3c.3-4.3-.7-8.1-2.8-11.4ZM9 13.9c-1 0-1.7-.9-1.7-1.9 0-1 .8-1.9 1.7-1.9 1 0 1.8.9 1.7 1.9 0 1-.8 1.9-1.7 1.9Zm6 0c-1 0-1.7-.9-1.7-1.9 0-1 .8-1.9 1.7-1.9 1 0 1.8.9 1.7 1.9 0 1-.8 1.9-1.7 1.9Z"/></svg>`;

function shell(name: string, innerHtml: string, ogImage: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>Verify · ${escapeHtml(name)}</title>
  <meta name="description" content="Pass a quick CAPTCHA to unlock the ${escapeHtml(name)} Discord." />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="Verify · ${escapeHtml(name)}" />
  <meta property="og:description" content="Pass a quick CAPTCHA to unlock the ${escapeHtml(name)} Discord." />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600&family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${portalCss()}</style>
</head>
<body>
  <main class="verify-wrap">
    <section class="verify-card">
      ${innerHtml}
    </section>
  </main>
</body>
</html>`;
}

// The portal page is identical for every visitor (depends only on static
// config), so build it once per config and reuse the string.
const portalPageCache = new Map<string, string>();

export function renderPortalPage(config: VerifyConfig, ogImage: string): string {
  const serverName = displayName(config);
  const cacheKey = `${config.turnstileSiteKey}|${serverName}|${ogImage}`;
  const cached = portalPageCache.get(cacheKey);
  if (cached) return cached;
  const inner = `
    <img class="verify-logo" src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(serverName)}" />
    <h1>Are you human?</h1>
    <p class="verify-sub">${escapeHtml(serverName)} · Access Check</p>
    <ul class="verify-steps">
      <li><span class="n">1</span> Pass the CAPTCHA below</li>
      <li><span class="n">2</span> Authorize with Discord</li>
      <li><span class="n">3</span> Receive your verified role</li>
    </ul>
    <div class="cf-holder">
      <div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstileSiteKey)}" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileReset" data-error-callback="onTurnstileReset" data-theme="dark"></div>
    </div>
    <button id="go" class="btn btn-primary btn-block" disabled>
      ${DISCORD_GLYPH}
      <span id="go-label">Continue with Discord</span>
    </button>
    <div class="verify-err" id="err"></div>
    <div class="verify-foot">Protected by Cloudflare Turnstile</div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <script>
      var captchaToken = null;
      function onTurnstileSuccess(t) {
        captchaToken = t;
        document.getElementById('go').disabled = false;
      }
      function onTurnstileReset() {
        captchaToken = null;
        document.getElementById('go').disabled = true;
      }
      document.getElementById('go').addEventListener('click', async function () {
        if (!captchaToken) return;
        var btn = document.getElementById('go');
        var label = document.getElementById('go-label');
        var err = document.getElementById('err');
        err.style.display = 'none';
        btn.disabled = true;
        label.textContent = 'Connecting to Discord...';
        try {
          var res = await fetch('/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: captchaToken })
          });
          var data = await res.json();
          if (res.ok && data.url) { window.location.href = data.url; return; }
          throw new Error(data.error || 'Verification failed. Please try again.');
        } catch (e) {
          err.textContent = e.message;
          err.style.display = 'block';
          label.textContent = 'Try again';
          captchaToken = null;
          if (window.turnstile) { try { turnstile.reset(); } catch (_) {} }
        }
      });
    </script>`;
  const html = shell(serverName, inner, ogImage);
  portalPageCache.set(cacheKey, html);
  return html;
}

export function renderResultPage(success: boolean, message: string): string {
  const inner = `
    <div class="result-badge ${success ? "ok" : "bad"}">${success ? "&#10003;" : "&#10005;"}</div>
    <h1>${success ? "Verified" : "Verification failed"}</h1>
    <p class="result-msg">${escapeHtml(message)}</p>
    ${success ? "" : `<div class="result-link"><a class="btn btn-secondary btn-block" href="/">Start Over</a></div>`}`;
  return shell(brand.name, inner, brand.ogFallbackImage);
}

// ========================================
// RESPONSE HELPERS
// ========================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirectUriFor(config: VerifyConfig, url: URL): string {
  return config.redirectUriOverride ?? `${url.origin}/callback`;
}

// ========================================
// ROUTE HANDLERS
// ========================================

async function handleStart(
  req: Request,
  url: URL,
  config: VerifyConfig,
): Promise<Response> {
  let token = "";
  try {
    const body = await req.json();
    token = String(body?.token ?? "");
  } catch {
    return jsonResponse({ error: "Bad request." }, 400);
  }
  if (!token) {
    return jsonResponse({ error: "Please complete the CAPTCHA first." }, 400);
  }

  const ok = await verifyTurnstile(
    config.turnstileSecretKey,
    token,
    req.headers.get("cf-connecting-ip"),
  );
  if (!ok) {
    return jsonResponse({ error: "CAPTCHA check failed. Please try again." }, 400);
  }

  const state = await mintState();
  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUriFor(config, url));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "identify");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "consent");

  return jsonResponse({ url: authUrl.toString() });
}

async function handleCallback(
  url: URL,
  config: VerifyConfig,
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return htmlResponse(renderResultPage(false, "Discord authorization was cancelled."));
  }
  if (!code || !state) {
    return htmlResponse(renderResultPage(false, "Missing authorization data. Please start over."));
  }

  const consumed = await consumeState(state);
  if (!consumed.ok) {
    return htmlResponse(renderResultPage(false, consumed.reason));
  }

  const accessToken = await exchangeCode(config, code, redirectUriFor(config, url));
  if (!accessToken) {
    return htmlResponse(renderResultPage(false, "Could not authenticate with Discord. Please start over."));
  }

  const user = await fetchDiscordUser(accessToken);
  if (!user) {
    return htmlResponse(renderResultPage(false, "Could not read your Discord profile. Please start over."));
  }

  const { status, body, code: errorCode } = await grantRole(config, user.id);

  if (status === 204) {
    await logVerification(user, true, "role granted");
    await maybeAlertRaid(config, displayName(config));
    const name = user.username ? `, ${user.username}` : "";
    return htmlResponse(
      renderResultPage(
        true,
        `You're all set${name}! Head back to Discord — your verified role has been granted. You can close this tab.`,
      ),
    );
  }

  // Record the precise failure for diagnostics (Discord error codes:
  // 10004 Unknown Guild, 10007 Unknown Member, 10011 Unknown Role,
  // 50013 Missing Permissions, 50001 Missing Access).
  await logVerification(
    user,
    false,
    `role grant failed: status=${status} code=${errorCode ?? "?"} body=${body.slice(0, 400)}`,
  );

  // Only a genuine "Unknown Member" means the user must join first.
  if (status === 404 && errorCode === 10007) {
    return htmlResponse(
      renderResultPage(false, "You're not in the server yet. Join the Discord first, then come back and verify."),
    );
  }
  // Everything else is a server-side configuration problem.
  let adminMessage = "Couldn't assign your role. The verification bot is misconfigured — please contact a moderator.";
  if (errorCode === 10004) {
    adminMessage = "The verification bot isn't connected to this server yet. Please contact a moderator.";
  } else if (errorCode === 10011) {
    adminMessage = "The verified role no longer exists or is misconfigured. Please contact a moderator.";
  } else if (status === 403 || errorCode === 50013 || errorCode === 50001) {
    adminMessage = "The bot doesn't have permission to grant the role (check its permissions and role position). Please contact a moderator.";
  }
  return htmlResponse(renderResultPage(false, adminMessage));
}

// ========================================
// PUBLIC ENTRY POINT
// ========================================

export async function handleVerifyRequest(
  req: Request,
  config: VerifyConfig,
): Promise<Response> {
  const url = new URL(req.url);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(renderPortalPage(config, `${url.origin}/og.png`), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/og.png") {
      try {
        const { readVerifyOgImage } = await import("./og.ts");
        const png = await readVerifyOgImage();
        if (png) {
          // A Uint8Array is a valid BodyInit at runtime; the cast satisfies the
          // DOM lib's narrower BufferSource typing.
          return new Response(png as BodyInit, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "cache-control": "public, max-age=86400, immutable",
            },
          });
        }
      } catch (e) {
        console.error("og read failed:", e);
      }
      // Not generated yet (the cron builds it) — fall back to the brand image.
      return new Response(null, {
        status: 302,
        headers: { location: brand.ogFallbackImage },
      });
    }
    if (req.method === "POST" && url.pathname === "/start") {
      return await handleStart(req, url, config);
    }
    if (req.method === "GET" && url.pathname === "/callback") {
      return await handleCallback(url, config);
    }
    return htmlResponse(renderResultPage(false, "Page not found."), 404);
  } catch (e) {
    console.error("verify error:", e);
    return htmlResponse(
      renderResultPage(false, "Something went wrong on our end. Please try again later."),
      500,
    );
  }
}
