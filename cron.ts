// ============================================================================
// Discord CAPTCHA Shield — data cleanup + OG card refresh (Val Town Cron)
// ============================================================================
//
// Set this file as the val's Cron trigger (daily is plenty). It prunes
// ephemeral state nonces, ages out the verification audit log, and regenerates
// the social card. Card generation is heavy (satori + resvg cold loads) and
// exceeds an HTTP request's wall-clock, so it lives here where the cron runs to
// completion; the /og.png route only serves the cached blob.
// ============================================================================

import { cleanupVerifyData } from "./mod.ts";
import { refreshVerifyOgImage } from "./og.ts";

const LOG_RETENTION_DAYS = 7;

export default async function () {
  const result = await cleanupVerifyData(LOG_RETENTION_DAYS);
  console.log(
    `verify cleanup: deleted ${result.states} state nonce(s), ${result.logs} log row(s) older than ${LOG_RETENTION_DAYS}d`,
  );

  try {
    const bytes = await refreshVerifyOgImage();
    console.log(`verify og.png refreshed: ${bytes} bytes`);
  } catch (e) {
    console.error("verify og refresh failed:", e);
  }
}
