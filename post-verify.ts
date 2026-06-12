// ============================================================================
// Post the verification message into Discord (manual trigger)
// ============================================================================
//
// Run this file (Val Town "Run" button) and the bot posts a branded embed + a
// link "Verify" button into DISCORD_VERIFY_CHANNEL_ID. Post it once; it lives
// in your verify channel.
//
// Requires:
//   DISCORD_BOT_TOKEN          the bot (already set for verification)
//   DISCORD_VERIFY_CHANNEL_ID  the channel to post into
//   VERIFY_PORTAL_URL          public portal URL (or derived from VERIFY_REDIRECT_URI)
//   VERIFY_SERVER_NAME         optional display name
// The bot must have Send Messages + Embed Links in that channel.
// ============================================================================

import { postVerifyMessage, type VerifyConfig } from "./mod.ts";
import { env, optEnv } from "./config.ts";

export async function main() {
  const redirect = optEnv("VERIFY_REDIRECT_URI");
  // postVerifyMessage only reads these fields; cast the partial as VerifyConfig.
  const config = {
    botToken: env("DISCORD_BOT_TOKEN"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    verifyChannelId: optEnv("DISCORD_VERIFY_CHANNEL_ID"),
    portalUrl: optEnv("VERIFY_PORTAL_URL") ??
      (redirect ? redirect.replace(/\/callback$/, "") : undefined),
  } as VerifyConfig;

  const result = await postVerifyMessage(config);
  console.log(
    result.ok
      ? `Verification message posted (${result.detail}).`
      : `Failed to post verification message: ${result.detail}`,
  );
  return result;
}

await main();
