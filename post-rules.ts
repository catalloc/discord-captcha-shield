// ============================================================================
// Post the server rules into Discord (manual trigger)
// ============================================================================
//
// Run this file and the bot posts the server's rules as a branded embed into
// its rules channel. Post it once.
//
// Which server: pass the guild id as the first CLI argument, or set
// TOOL_GUILD_ID / DISCORD_GUILD_ID. The rules channel + branding (including the
// rules list) come from the registered server's config; the bot token is shared
// env. The bot needs Send Messages + Embed Links in that channel.
// ============================================================================

import { postRulesMessage } from "./mod.ts";
import { loadGuildToolConfig, toolGuildId } from "./config.ts";

export async function main(guildId: string = toolGuildId()) {
  const config = await loadGuildToolConfig(guildId);
  if (!config) {
    console.error(`Server ${guildId} isn't registered (POST /admin/guilds first).`);
    return;
  }
  const result = await postRulesMessage(config);
  console.log(
    result.ok
      ? `Rules message posted (${result.detail}).`
      : `Failed to post rules message: ${result.detail}`,
  );
  return result;
}

await main();
