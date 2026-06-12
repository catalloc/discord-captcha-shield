// ============================================================================
// Post the "About the community" message into Discord (manual trigger)
// ============================================================================
//
// Run this file and the bot posts a branded "About" embed into the server's
// about channel. Put that channel in the DMZ — somewhere unverified members can
// see — so newcomers know what they're joining before they verify. Post once.
//
// Which server: pass the guild id as the first CLI argument, or set
// TOOL_GUILD_ID / DISCORD_GUILD_ID. The about/verify/rules channels, branding,
// and portal URL come from the registered server's config; the bot token is
// shared env. The bot needs Send Messages + Embed Links in that channel.
// ============================================================================

import { postAboutMessage } from "./mod.ts";
import { loadGuildToolConfig, toolGuildId } from "./config.ts";

export async function main(guildId: string = toolGuildId()) {
  const config = await loadGuildToolConfig(guildId);
  if (!config) {
    console.error(`Server ${guildId} isn't registered (POST /admin/guilds first).`);
    return;
  }
  const result = await postAboutMessage(config);
  console.log(
    result.ok
      ? `About message posted (${result.detail}).`
      : `Failed to post about message: ${result.detail}`,
  );
  return result;
}

await main();
