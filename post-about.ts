// ============================================================================
// Post the "About the community" message into Discord (manual trigger)
// ============================================================================
//
// Run this file (Val Town "Run" button) and the bot posts a branded "About"
// embed (from theme.ts) into DISCORD_ABOUT_CHANNEL_ID. Put this channel in the
// DMZ — somewhere unverified members can see — so newcomers know what they're
// joining before they verify. Post it once.
//
// Requires: DISCORD_BOT_TOKEN, DISCORD_ABOUT_CHANNEL_ID (numeric ID, channel
// link, or #mention all accepted). Optional: VERIFY_SERVER_NAME,
// VERIFY_PORTAL_URL (adds a Verify button), DISCORD_VERIFY_CHANNEL_ID and
// DISCORD_RULES_CHANNEL_ID (linked as #mentions in the embed).
// The bot needs Send Messages + Embed Links in that channel.
// ============================================================================

import { postAboutMessage, type VerifyConfig } from "./mod.ts";
import { env, optEnv } from "./config.ts";

export async function main() {
  const redirect = optEnv("VERIFY_REDIRECT_URI");
  const config = {
    botToken: env("DISCORD_BOT_TOKEN"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    aboutChannelId: optEnv("DISCORD_ABOUT_CHANNEL_ID"),
    verifyChannelId: optEnv("DISCORD_VERIFY_CHANNEL_ID"),
    rulesChannelId: optEnv("DISCORD_RULES_CHANNEL_ID"),
    portalUrl: optEnv("VERIFY_PORTAL_URL") ??
      (redirect ? redirect.replace(/\/callback$/, "") : undefined),
  } as VerifyConfig;

  const result = await postAboutMessage(config);
  console.log(
    result.ok
      ? `About message posted (${result.detail}).`
      : `Failed to post about message: ${result.detail}`,
  );
  return result;
}

await main();
