// ============================================================================
// Post the honeypot warning into Discord (manual trigger)
// ============================================================================
//
// Run this file (Val Town "Run" button) and the bot posts a small "do not post
// here" embed into DISCORD_HONEYPOT_CHANNEL_ID, pointing legit users to the
// verify channel (and rules). The honeypot is a trap: bots that auto-spam every
// channel post here and out themselves — pair it with an AutoMod rule or manual
// review to ban anyone who posts.
//
// Requires: DISCORD_BOT_TOKEN, DISCORD_HONEYPOT_CHANNEL_ID. Uses
// DISCORD_VERIFY_CHANNEL_ID and DISCORD_RULES_CHANNEL_ID for the in-embed links
// (numeric ID, channel link, or #mention all accepted). Optional:
// VERIFY_SERVER_NAME. Bot needs Send Messages + Embed Links in that channel.
// ============================================================================

import { postHoneypotMessage, type VerifyConfig } from "./mod.ts";
import { env, optEnv } from "./config.ts";

export async function main() {
  const config = {
    botToken: env("DISCORD_BOT_TOKEN"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    honeypotChannelId: optEnv("DISCORD_HONEYPOT_CHANNEL_ID"),
    verifyChannelId: optEnv("DISCORD_VERIFY_CHANNEL_ID"),
    rulesChannelId: optEnv("DISCORD_RULES_CHANNEL_ID"),
  } as VerifyConfig;

  const result = await postHoneypotMessage(config);
  console.log(
    result.ok
      ? `Honeypot message posted (${result.detail}).`
      : `Failed to post honeypot message: ${result.detail}`,
  );
  return result;
}

await main();
