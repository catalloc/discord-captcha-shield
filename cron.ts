// ============================================================================
// Discord CAPTCHA Shield — data cleanup + OG card refresh (Val Town Cron)
// ============================================================================
//
// Set this file as the val's Cron trigger (daily is plenty). It prunes
// ephemeral state nonces, ages out the verification audit log, and regenerates
// each shielded server's social card. Card generation is heavy (satori + resvg
// cold loads) and exceeds an HTTP request's wall-clock, so it lives here where
// the cron runs to completion; the og.png route only serves the cached blob.
// ============================================================================

import { cleanupVerifyData } from "./mod.ts";
import { refreshVerifyOgImage } from "./og.ts";
import { listGuilds, resolveGuildTheme } from "./guilds.ts";
import { seedLegacyGuildFromEnv } from "./config.ts";

const LOG_RETENTION_DAYS = 7;

export default async function () {
  // Keep an upgraded single-guild deployment migrated even if no HTTP request
  // has triggered the seed yet.
  await seedLegacyGuildFromEnv();

  const result = await cleanupVerifyData(LOG_RETENTION_DAYS);
  console.log(
    `verify cleanup: deleted ${result.states} state nonce(s), ${result.logs} log row(s) older than ${LOG_RETENTION_DAYS}d`,
  );

  // Refresh every registered server's card.
  const guilds = await listGuilds();
  for (const g of guilds) {
    try {
      const theme = await resolveGuildTheme(g.guildId);
      const bytes = await refreshVerifyOgImage(g.guildId, theme);
      console.log(`verify og.png[${g.guildId}] refreshed: ${bytes} bytes`);
    } catch (e) {
      console.error(`verify og refresh failed for ${g.guildId}:`, e);
    }
  }
}
