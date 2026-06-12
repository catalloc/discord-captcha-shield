// ============================================================================
// Post the server rules into Discord (manual trigger)
// ============================================================================
//
// Run this file (Val Town "Run" button) and the bot posts the rules (from
// theme.ts) as a branded embed into DISCORD_RULES_CHANNEL_ID. Post it once.
//
// Requires: DISCORD_BOT_TOKEN, DISCORD_RULES_CHANNEL_ID (numeric ID, channel
// link, or #mention all accepted). Optional: VERIFY_SERVER_NAME (footer).
// The bot needs Send Messages + Embed Links in that channel.
// ============================================================================

import { postRulesMessage, type VerifyConfig } from "./mod.ts";
import { env, optEnv } from "./config.ts";

export async function main() {
  const config = {
    botToken: env("DISCORD_BOT_TOKEN"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    rulesChannelId: optEnv("DISCORD_RULES_CHANNEL_ID"),
  } as VerifyConfig;

  const result = await postRulesMessage(config);
  console.log(
    result.ok
      ? `Rules message posted (${result.detail}).`
      : `Failed to post rules message: ${result.detail}`,
  );
  return result;
}

await main();
