/**
 * Configuration loading for the Discord CAPTCHA Shield.
 *
 * Multi-tenant split:
 *   - SHARED, per-deployment values come from env (Val Town Settings →
 *     Environment Variables): the one Discord app's credentials, the bot token,
 *     a default Turnstile keypair, and the admin secret. See loadSharedEnv().
 *   - PER-SERVER values come from the captcha_guilds SQLite table (see
 *     guilds.ts): role, branding, channels, alert tuning, optional Turnstile
 *     override. loadGuildConfig() merges a server's row with the shared env to
 *     build the VerifyConfig the request handlers consume.
 *
 * Visual branding lives in ./theme.ts (defaults) and per-server overrides in
 * the guild row. See README.md for the full variable reference.
 */

import type { VerifyConfig } from "./mod.ts";
import { type GuildConfig, getGuild, upsertGuild } from "./guilds.ts";
import { migrateLegacyLog } from "./schema.ts";
import { migrateLegacyKeys } from "./store.ts";

/** Required env var — throws a clear error if unset. */
export function env(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** Optional env var. Guarded with has() so we never get() an unset key
 *  (avoids Val Town's "environment variable not set" log warnings). */
export function optEnv(key: string): string | undefined {
  return Deno.env.has(key) ? (Deno.env.get(key) || undefined) : undefined;
}

/** Optional numeric env var; undefined if unset or not a finite number. */
export function optNum(key: string): number | undefined {
  const raw = optEnv(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Optional "minutes" env var, returned as milliseconds. */
export function optMinutesToMs(key: string): number | undefined {
  const min = optNum(key);
  return min === undefined ? undefined : min * 60 * 1000;
}

/**
 * Shared, per-deployment configuration: the single Discord app + bot all
 * shielded servers run through, a default Turnstile keypair, and the admin
 * secret. Per-server values come from the guild row, not from here.
 */
export interface SharedEnv {
  clientId: string;
  clientSecret: string;
  botToken: string;
  /** Default Turnstile site key. Optional — a guild may set its own. */
  turnstileSiteKey?: string;
  /** Default Turnstile secret key. Optional — a guild may set its own. */
  turnstileSecretKey?: string;
  /** Bearer secret guarding the /admin API. No admin API if unset. */
  adminSecret?: string;
}

/** Load the shared, per-deployment env. The Discord app credentials are
 *  required; Turnstile keys are optional here because a guild may override. */
export function loadSharedEnv(): SharedEnv {
  return {
    clientId: env("DISCORD_CLIENT_ID"),
    clientSecret: env("DISCORD_CLIENT_SECRET"),
    botToken: env("DISCORD_BOT_TOKEN"),
    turnstileSiteKey: optEnv("TURNSTILE_SITE_KEY"),
    turnstileSecretKey: optEnv("TURNSTILE_SECRET_KEY"),
    adminSecret: optEnv("ADMIN_SECRET"),
  };
}

/** Merge a guild row with the shared env into a VerifyConfig. Turnstile keys
 *  fall back to "" when neither per-guild nor shared — callers that need them
 *  (the verification flow) must check; tooling that doesn't can ignore. */
function mergeGuildConfig(
  guild: GuildConfig,
  shared: SharedEnv,
): VerifyConfig {
  return {
    clientId: shared.clientId,
    clientSecret: shared.clientSecret,
    botToken: shared.botToken,
    guildId: guild.guildId,
    roleId: guild.roleId,
    turnstileSiteKey: guild.turnstileSiteKey ?? shared.turnstileSiteKey ?? "",
    turnstileSecretKey: guild.turnstileSecretKey ??
      shared.turnstileSecretKey ?? "",
    serverName: guild.serverName,
    redirectUriOverride: guild.redirectUriOverride,
    alertWebhookUrl: guild.alertWebhookUrl,
    raidThreshold: guild.raidThreshold,
    raidWindowMs: guild.raidWindowMs,
    alertCooldownMs: guild.alertCooldownMs,
    verifyChannelId: guild.verifyChannelId,
    rulesChannelId: guild.rulesChannelId,
    honeypotChannelId: guild.honeypotChannelId,
    aboutChannelId: guild.aboutChannelId,
    portalUrl: guild.portalUrl,
  };
}

/**
 * Build a VerifyConfig for one server for the verification flow. Returns null
 * when the server isn't registered or is disabled. Throws only when no
 * Turnstile keys are available at all (neither per-guild nor a shared default)
 * — a genuine misconfiguration the visitor can't get past.
 */
export async function loadGuildConfig(
  guildId: string,
  shared: SharedEnv = loadSharedEnv(),
): Promise<VerifyConfig | null> {
  const guild = await getGuild(guildId);
  if (!guild || guild.disabled) return null;

  const config = mergeGuildConfig(guild, shared);
  if (!config.turnstileSiteKey || !config.turnstileSecretKey) {
    throw new Error(
      `No Turnstile keys for guild ${guildId}: set them on the guild or via ` +
        `the TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY env defaults.`,
    );
  }
  return config;
}

/**
 * Build a VerifyConfig for the admin/DMZ tools (setup.ts, post-*.ts). Unlike
 * loadGuildConfig this does NOT require Turnstile keys (the tools only post
 * messages + create channels) and works on disabled servers. Returns null when
 * the server isn't registered.
 */
export async function loadGuildToolConfig(
  guildId: string,
  shared: SharedEnv = loadSharedEnv(),
): Promise<VerifyConfig | null> {
  const guild = await getGuild(guildId);
  return guild ? mergeGuildConfig(guild, shared) : null;
}

/**
 * Resolve which server a manual tool run targets. Order: explicit argument, the
 * first CLI arg, then the TOOL_GUILD_ID / DISCORD_GUILD_ID env vars. Throws a
 * clear error if none is set.
 */
export function toolGuildId(explicit?: string): string {
  const id = explicit ?? Deno.args?.[0] ?? optEnv("TOOL_GUILD_ID") ??
    optEnv("DISCORD_GUILD_ID");
  if (!id) {
    throw new Error(
      "No server specified. Pass a guild id as the first argument, or set " +
        "TOOL_GUILD_ID (or DISCORD_GUILD_ID) in the environment.",
    );
  }
  return id;
}

/**
 * One-time migration for deployments upgrading from the single-guild build.
 *
 * If DISCORD_GUILD_ID is still set in env and no matching guild row exists yet,
 * seed a captcha_guilds row from the legacy env vars and backfill `guild_id` on
 * existing state/log rows so the audit history isn't orphaned. Returns the
 * seeded guild id (or the already-present one), else null. Safe to call on
 * every boot — it no-ops once the row exists.
 */
export async function seedLegacyGuildFromEnv(): Promise<string | null> {
  const guildId = optEnv("DISCORD_GUILD_ID");
  if (!guildId) return null;
  if (await getGuild(guildId)) return guildId;

  const redirect = optEnv("VERIFY_REDIRECT_URI");
  await upsertGuild({
    guildId,
    roleId: env("DISCORD_ROLE_ID"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    turnstileSiteKey: optEnv("TURNSTILE_SITE_KEY"),
    turnstileSecretKey: optEnv("TURNSTILE_SECRET_KEY"),
    alertWebhookUrl: optEnv("VERIFY_ALERT_WEBHOOK"),
    raidThreshold: optNum("VERIFY_RAID_THRESHOLD"),
    raidWindowMs: optMinutesToMs("VERIFY_RAID_WINDOW_MIN"),
    alertCooldownMs: optMinutesToMs("VERIFY_ALERT_COOLDOWN_MIN"),
    verifyChannelId: optEnv("DISCORD_VERIFY_CHANNEL_ID"),
    rulesChannelId: optEnv("DISCORD_RULES_CHANNEL_ID"),
    honeypotChannelId: optEnv("DISCORD_HONEYPOT_CHANNEL_ID"),
    aboutChannelId: optEnv("DISCORD_ABOUT_CHANNEL_ID"),
    portalUrl: optEnv("VERIFY_PORTAL_URL") ??
      (redirect ? redirect.replace(/\/callback$/, "") : undefined),
    redirectUriOverride: redirect,
  });
  // Copy the single-guild audit log forward into the guild-scoped table.
  await migrateLegacyLog(guildId);
  // Re-home channel/message IDs from the old un-namespaced blob keys so post
  // tools keep editing in place instead of duplicating.
  await migrateLegacyKeys(guildId);
  return guildId;
}

/**
 * LEGACY single-guild loader — builds a VerifyConfig straight from env.
 *
 * @deprecated Retained so the current HTTP/cron/setup entry points keep working
 * until they are rewired to the per-guild router. New code should resolve a
 * server with loadGuildConfig(guildId). Removed once routing lands.
 */
export function loadConfig(): VerifyConfig {
  const redirect = optEnv("VERIFY_REDIRECT_URI");
  return {
    clientId: env("DISCORD_CLIENT_ID"),
    clientSecret: env("DISCORD_CLIENT_SECRET"),
    botToken: env("DISCORD_BOT_TOKEN"),
    guildId: env("DISCORD_GUILD_ID"),
    roleId: env("DISCORD_ROLE_ID"),
    turnstileSiteKey: env("TURNSTILE_SITE_KEY"),
    turnstileSecretKey: env("TURNSTILE_SECRET_KEY"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    redirectUriOverride: redirect,
    alertWebhookUrl: optEnv("VERIFY_ALERT_WEBHOOK"),
    raidThreshold: optNum("VERIFY_RAID_THRESHOLD"),
    raidWindowMs: optMinutesToMs("VERIFY_RAID_WINDOW_MIN"),
    alertCooldownMs: optMinutesToMs("VERIFY_ALERT_COOLDOWN_MIN"),
    verifyChannelId: optEnv("DISCORD_VERIFY_CHANNEL_ID"),
    rulesChannelId: optEnv("DISCORD_RULES_CHANNEL_ID"),
    honeypotChannelId: optEnv("DISCORD_HONEYPOT_CHANNEL_ID"),
    aboutChannelId: optEnv("DISCORD_ABOUT_CHANNEL_ID"),
    portalUrl: optEnv("VERIFY_PORTAL_URL") ??
      (redirect ? redirect.replace(/\/callback$/, "") : undefined),
  };
}
