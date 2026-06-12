/**
 * Centralized SQLite schema + migrations for the Discord CAPTCHA Shield.
 *
 * Owns every table the shield touches so the DDL lives in ONE place:
 *   - captcha_guilds          per-server config + white-label branding
 *   - captcha_verify_states_v2 one-time OAuth state nonces (guild-scoped)
 *   - captcha_verify_log_v2   verification audit log      (guild-scoped)
 *   - captcha_verify_alerts   raid-alert debounce state   (scoped via the kind)
 *
 * Migration style (per AGENTS.md): we do NOT ALTER existing tables. Adding the
 * multi-tenant `guild_id` column means a NEW table name (`*_v2`) created fresh
 * with the column already present. Upgrading from the single-guild build:
 *   - state nonces are ephemeral (10-min TTL) — the new table just starts empty
 *   - the audit log is copied across (guild_id set to the legacy server) by
 *     migrateLegacyLog(), called once from the legacy-env migration
 *   - the alerts table is UNCHANGED (its schema is the same; the guild is
 *     namespaced into the `kind` value, e.g. `raid:<guildId>`)
 *
 * `ensureSchema()` is idempotent (CREATE TABLE IF NOT EXISTS) and memoized per
 * isolate, so call it freely before any query.
 */

import { sqlite } from "https://esm.town/v/std/sqlite";

export const GUILDS_TABLE = "captcha_guilds";
export const STATES_TABLE = "captcha_verify_states_v2";
export const LOG_TABLE = "captcha_verify_log_v2";
export const ALERTS_TABLE = "captcha_verify_alerts";

// Single-guild predecessor of LOG_TABLE (no guild_id). Read once during the
// legacy migration to copy history forward, never written to again.
const LEGACY_LOG_TABLE = "captcha_verify_log";

let schemaReady = false;

/**
 * Create every table. Idempotent and memoized per isolate. Fresh databases and
 * upgrades alike get the full multi-tenant schema — no ALTER needed because the
 * guild-scoped tables carry new names.
 */
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;

  // --- Per-server config + branding ---------------------------------------
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${GUILDS_TABLE} (
      guild_id              TEXT PRIMARY KEY,
      role_id               TEXT NOT NULL,
      server_name           TEXT,
      disabled              INTEGER NOT NULL DEFAULT 0,
      brand_name            TEXT,
      logo_url              TEXT,
      accent_color          TEXT,
      accent_color_bright   TEXT,
      embed_color           INTEGER,
      og_headline           TEXT,
      og_tagline            TEXT,
      og_fallback_image     TEXT,
      rules_json            TEXT,
      about_json            TEXT,
      turnstile_site_key    TEXT,
      turnstile_secret_key  TEXT,
      alert_webhook_url     TEXT,
      raid_threshold        INTEGER,
      raid_window_ms        INTEGER,
      alert_cooldown_ms     INTEGER,
      verify_channel_id     TEXT,
      rules_channel_id      TEXT,
      about_channel_id      TEXT,
      honeypot_channel_id   TEXT,
      portal_url            TEXT,
      redirect_uri_override TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    )
  `);

  // --- One-time OAuth state nonces (guild-scoped) -------------------------
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${STATES_TABLE} (
      state TEXT PRIMARY KEY,
      guild_id TEXT,
      created_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);

  // --- Verification audit log (guild-scoped) ------------------------------
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      discord_user_id TEXT NOT NULL,
      discord_username TEXT,
      created_at INTEGER NOT NULL,
      success INTEGER NOT NULL,
      detail TEXT
    )
  `);

  // Raid-detection COUNT is `WHERE guild_id = ? AND success = 1 AND created_at
  // > ?`; lead with guild_id so the scan is an index seek per tenant.
  await sqlite.execute(`
    CREATE INDEX IF NOT EXISTS idx_${LOG_TABLE}_guild_success_created
    ON ${LOG_TABLE} (guild_id, success, created_at)
  `);

  // --- Raid-alert debounce (one row per guild+kind via the kind value) ----
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS ${ALERTS_TABLE} (
      kind TEXT PRIMARY KEY,
      last_alert_at INTEGER NOT NULL
    )
  `);

  schemaReady = true;
}

/**
 * One-time copy of the single-guild audit log into the guild-scoped table,
 * stamping every legacy row with `guildId` (the one server the old deployment
 * served). Best-effort: no-ops if the old table is absent (fresh install) or
 * the new table already holds rows (already migrated / live traffic). Called
 * once from the legacy-env migration, after the guild row is seeded.
 */
export async function migrateLegacyLog(guildId: string): Promise<void> {
  await ensureSchema();
  try {
    // Don't copy if the new log already has data — avoids duplicating history
    // on a re-run or a cold-boot race.
    const have = await sqlite.execute(`SELECT COUNT(*) FROM ${LOG_TABLE}`);
    if (Number(have.rows?.[0]?.[0] ?? 0) > 0) return;

    await sqlite.execute({
      sql: `INSERT INTO ${LOG_TABLE}
              (guild_id, discord_user_id, discord_username, created_at, success, detail)
            SELECT ?, discord_user_id, discord_username, created_at, success, detail
            FROM ${LEGACY_LOG_TABLE}`,
      args: [guildId],
    });
  } catch {
    // Old table missing or unreadable — nothing to migrate.
  }
}
