/**
 * Environment loading for the Discord CAPTCHA Shield.
 *
 * All secrets and per-deployment IDs come from Val Town environment variables
 * (Settings → Environment Variables). Visual branding lives in ./theme.ts; this
 * file only reads env. See README.md for the full variable reference.
 */

import type { VerifyConfig } from "./mod.ts";

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

/** Build the full VerifyConfig from env (used by the HTTP entry point). */
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
