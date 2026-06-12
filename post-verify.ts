// ============================================================================
// Post the verification message into Discord (manual trigger)
// ============================================================================
//
// Run this file and the bot posts a branded embed + a link "Verify" button into
// the server's verify channel. Post it once; it lives in that channel.
//
// Which server: pass the guild id as the first CLI argument, or set
// TOOL_GUILD_ID / DISCORD_GUILD_ID. The verify channel, branding, and portal
// URL come from the registered server's config; the bot token + client id are
// shared env. The bot must have Send Messages + Embed Links in that channel.
// ============================================================================

import { postVerifyMessage } from "./mod.ts";
import { loadGuildToolConfig, toolGuildId } from "./config.ts";

export async function main(guildId: string = toolGuildId()) {
  const config = await loadGuildToolConfig(guildId);
  if (!config) {
    console.error(`Server ${guildId} isn't registered (POST /admin/guilds first).`);
    return;
  }
  const result = await postVerifyMessage(config);
  console.log(
    result.ok
      ? `Verification message posted (${result.detail}).`
      : `Failed to post verification message: ${result.detail}`,
  );
  return result;
}

await main();
