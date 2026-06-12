// ============================================================================
// Post the honeypot warning into Discord (manual trigger)
// ============================================================================
//
// Run this file and the bot posts a small "do not post here" embed into the
// server's honeypot channel, pointing legit users to the verify channel (and
// rules). The honeypot is a trap: bots that auto-spam every channel post here
// and out themselves — pair it with an AutoMod rule or manual review to ban
// anyone who posts.
//
// Which server: pass the guild id as the first CLI argument, or set
// TOOL_GUILD_ID / DISCORD_GUILD_ID. The honeypot/verify/rules channels and
// branding come from the registered server's config; the bot token is shared
// env. The bot needs Send Messages + Embed Links in that channel.
// ============================================================================

import { postHoneypotMessage } from "./mod.ts";
import { loadGuildToolConfig, toolGuildId } from "./config.ts";

export async function main(guildId: string = toolGuildId()) {
  const config = await loadGuildToolConfig(guildId);
  if (!config) {
    console.error(`Server ${guildId} isn't registered (POST /admin/guilds first).`);
    return;
  }
  const result = await postHoneypotMessage(config);
  console.log(
    result.ok
      ? `Honeypot message posted (${result.detail}).`
      : `Failed to post honeypot message: ${result.detail}`,
  );
  return result;
}

await main();
