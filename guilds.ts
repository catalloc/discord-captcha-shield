/**
 * Per-server config registry — the source of truth for which Discord servers
 * this deployment shields and how each is configured.
 *
 * One row per guild in the captcha_guilds table (see schema.ts). A row holds
 * the server's role + identity, optional white-label branding overrides (logo,
 * colors, copy, rules), optional per-guild Turnstile keys, alert tuning, and
 * DMZ channel IDs. Anything left null falls back to the shared env / theme.ts
 * defaults at load time (see config.ts `loadGuildConfig` and the theme step).
 *
 * Storing config in SQLite (rather than env) is what makes this multi-tenant:
 * servers can be added, edited, and removed at runtime via the guarded admin
 * API without redeploying the val.
 */

import { sqlite } from "https://esm.town/v/std/sqlite";
import {
  type AboutInfo,
  type ResolvedTheme,
  resolveTheme,
  type Rule,
} from "./theme.ts";
import { ensureSchema, GUILDS_TABLE } from "./schema.ts";

/**
 * A server's stored configuration. Optional fields are overrides — when unset,
 * the resolver falls back to shared env (secrets, default Turnstile keys) or to
 * theme.ts (branding). `guildId` + `roleId` are the only hard requirements.
 */
export interface GuildConfig {
  guildId: string;
  roleId: string;
  serverName?: string;
  disabled: boolean;

  // White-label branding overrides (undefined => theme.ts default).
  brandName?: string;
  logoUrl?: string;
  accentColor?: string; // hex, e.g. "#F4A340"
  accentColorBright?: string; // hex
  embedColor?: number; // Discord int color, e.g. 0xf4a340
  ogHeadline?: string;
  ogTagline?: string;
  ogFallbackImage?: string;
  rules?: Rule[];
  about?: AboutInfo;

  // Per-guild Turnstile keys (undefined => shared TURNSTILE_* env default).
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;

  // Raid-alert config.
  alertWebhookUrl?: string;
  raidThreshold?: number;
  raidWindowMs?: number;
  alertCooldownMs?: number;

  // DMZ channels (blob store stays primary; these are env-style fallbacks).
  verifyChannelId?: string;
  rulesChannelId?: string;
  aboutChannelId?: string;
  honeypotChannelId?: string;

  // Portal addressing.
  portalUrl?: string;
  redirectUriOverride?: string;

  createdAt: number;
  updatedAt: number;
}

/** Shape accepted when creating/updating a server. Timestamps are stamped by
 *  upsertGuild; `disabled` defaults to false. */
export type GuildInput =
  & Omit<GuildConfig, "disabled" | "createdAt" | "updatedAt">
  & { disabled?: boolean };

// Column order for the upsert. Keep in sync with the CREATE in schema.ts.
const COLS = [
  "guild_id",
  "role_id",
  "server_name",
  "disabled",
  "brand_name",
  "logo_url",
  "accent_color",
  "accent_color_bright",
  "embed_color",
  "og_headline",
  "og_tagline",
  "og_fallback_image",
  "rules_json",
  "about_json",
  "turnstile_site_key",
  "turnstile_secret_key",
  "alert_webhook_url",
  "raid_threshold",
  "raid_window_ms",
  "alert_cooldown_ms",
  "verify_channel_id",
  "rules_channel_id",
  "about_channel_id",
  "honeypot_channel_id",
  "portal_url",
  "redirect_uri_override",
  "created_at",
  "updated_at",
] as const;

/** Zip a result row's values onto its column names for order-independent reads. */
function rowObject(
  columns: string[],
  row: unknown[],
): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  columns.forEach((c, i) => (o[c] = row[i]));
  return o;
}

/** Parse a JSON column; undefined on null/blank/garbage (never throws). */
function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined =>
  v == null ? undefined : String(v);
const num = (v: unknown): number | undefined =>
  v == null ? undefined : Number(v);

/** Map a captcha_guilds row object to a GuildConfig. */
function rowToGuild(o: Record<string, unknown>): GuildConfig {
  return {
    guildId: String(o.guild_id),
    roleId: String(o.role_id),
    serverName: str(o.server_name),
    disabled: Number(o.disabled) === 1,
    brandName: str(o.brand_name),
    logoUrl: str(o.logo_url),
    accentColor: str(o.accent_color),
    accentColorBright: str(o.accent_color_bright),
    embedColor: num(o.embed_color),
    ogHeadline: str(o.og_headline),
    ogTagline: str(o.og_tagline),
    ogFallbackImage: str(o.og_fallback_image),
    rules: parseJson<Rule[]>(o.rules_json),
    about: parseJson<AboutInfo>(o.about_json),
    turnstileSiteKey: str(o.turnstile_site_key),
    turnstileSecretKey: str(o.turnstile_secret_key),
    alertWebhookUrl: str(o.alert_webhook_url),
    raidThreshold: num(o.raid_threshold),
    raidWindowMs: num(o.raid_window_ms),
    alertCooldownMs: num(o.alert_cooldown_ms),
    verifyChannelId: str(o.verify_channel_id),
    rulesChannelId: str(o.rules_channel_id),
    aboutChannelId: str(o.about_channel_id),
    honeypotChannelId: str(o.honeypot_channel_id),
    portalUrl: str(o.portal_url),
    redirectUriOverride: str(o.redirect_uri_override),
    createdAt: Number(o.created_at),
    updatedAt: Number(o.updated_at),
  };
}

/** Fetch one server's config. Null if it was never registered. */
export async function getGuild(guildId: string): Promise<GuildConfig | null> {
  await ensureSchema();
  const res = await sqlite.execute({
    sql: `SELECT * FROM ${GUILDS_TABLE} WHERE guild_id = ?`,
    args: [guildId],
  });
  const row = res.rows?.[0];
  if (!row) return null;
  return rowToGuild(rowObject(res.columns ?? [], row as unknown[]));
}

/** All registered servers, newest first. */
export async function listGuilds(): Promise<GuildConfig[]> {
  await ensureSchema();
  const res = await sqlite.execute(
    `SELECT * FROM ${GUILDS_TABLE} ORDER BY created_at DESC`,
  );
  const columns = res.columns ?? [];
  return (res.rows ?? []).map((row) =>
    rowToGuild(rowObject(columns, row as unknown[]))
  );
}

/**
 * Create or update a server's config (keyed by guild_id). On update, every
 * field is replaced from the input except `created_at` (preserved); set or
 * clear an override by passing a value or leaving it undefined.
 */
export async function upsertGuild(input: GuildInput): Promise<void> {
  await ensureSchema();
  const now = Date.now();
  const data: Record<string, unknown> = {
    guild_id: input.guildId,
    role_id: input.roleId,
    server_name: input.serverName ?? null,
    disabled: input.disabled ? 1 : 0,
    brand_name: input.brandName ?? null,
    logo_url: input.logoUrl ?? null,
    accent_color: input.accentColor ?? null,
    accent_color_bright: input.accentColorBright ?? null,
    embed_color: input.embedColor ?? null,
    og_headline: input.ogHeadline ?? null,
    og_tagline: input.ogTagline ?? null,
    og_fallback_image: input.ogFallbackImage ?? null,
    rules_json: input.rules ? JSON.stringify(input.rules) : null,
    about_json: input.about ? JSON.stringify(input.about) : null,
    turnstile_site_key: input.turnstileSiteKey ?? null,
    turnstile_secret_key: input.turnstileSecretKey ?? null,
    alert_webhook_url: input.alertWebhookUrl ?? null,
    raid_threshold: input.raidThreshold ?? null,
    raid_window_ms: input.raidWindowMs ?? null,
    alert_cooldown_ms: input.alertCooldownMs ?? null,
    verify_channel_id: input.verifyChannelId ?? null,
    rules_channel_id: input.rulesChannelId ?? null,
    about_channel_id: input.aboutChannelId ?? null,
    honeypot_channel_id: input.honeypotChannelId ?? null,
    portal_url: input.portalUrl ?? null,
    redirect_uri_override: input.redirectUriOverride ?? null,
    created_at: now,
    updated_at: now,
  };

  // Update everything except the identity and the original creation time.
  const updatable = COLS.filter((c) => c !== "guild_id" && c !== "created_at");
  const setClause = updatable.map((c) => `${c} = excluded.${c}`).join(", ");

  await sqlite.execute({
    sql: `INSERT INTO ${GUILDS_TABLE} (${COLS.join(", ")})
          VALUES (${COLS.map(() => "?").join(", ")})
          ON CONFLICT(guild_id) DO UPDATE SET ${setClause}`,
    args: COLS.map((c) => data[c] as never),
  });
}

/** Toggle a server on/off without deleting its config. Disabled servers stop
 *  resolving (the portal + callback treat them as unknown). */
export async function setGuildDisabled(
  guildId: string,
  disabled: boolean,
): Promise<void> {
  await ensureSchema();
  await sqlite.execute({
    sql: `UPDATE ${GUILDS_TABLE} SET disabled = ?, updated_at = ?
          WHERE guild_id = ?`,
    args: [disabled ? 1 : 0, Date.now(), guildId],
  });
}

/** Permanently remove a server's config. Verification stops immediately; its
 *  state/log rows age out on their own via the cron. */
export async function deleteGuild(guildId: string): Promise<void> {
  await ensureSchema();
  await sqlite.execute({
    sql: `DELETE FROM ${GUILDS_TABLE} WHERE guild_id = ?`,
    args: [guildId],
  });
}

/**
 * Resolve a server's full theme: its stored branding overrides layered over the
 * theme.ts defaults. Returns the bare defaults when the guild is unknown (or
 * undefined), so callers always get a complete ResolvedTheme.
 */
export async function resolveGuildTheme(
  guildId: string | undefined,
): Promise<ResolvedTheme> {
  const g = guildId ? await getGuild(guildId) : null;
  if (!g) return resolveTheme();
  return resolveTheme({
    serverName: g.serverName,
    brandName: g.brandName,
    logoUrl: g.logoUrl,
    accentColor: g.accentColor,
    accentColorBright: g.accentColorBright,
    embedColor: g.embedColor,
    ogHeadline: g.ogHeadline,
    ogTagline: g.ogTagline,
    ogFallbackImage: g.ogFallbackImage,
    rules: g.rules,
    about: g.about,
  });
}
