// ============================================================================
// One-shot DMZ bootstrap (manual trigger)
// ============================================================================
//
// Run this file to stand up the whole DMZ for ONE server:
//   1. Creates a "Welcome" category + #about, #rules, #verify, #do-not-post
//      channels with read-only @everyone overwrites (the honeypot stays open).
//   2. Posts the about / rules / verify / honeypot messages into them.
// Every channel + message ID is saved to blob storage (namespaced per guild),
// so re-running any post-*.ts afterwards EDITS its message in place instead of
// duplicating, and re-running setup.ts skips channels that already exist.
//
// Which server: pass the guild id as the first CLI argument, or set
// TOOL_GUILD_ID / DISCORD_GUILD_ID. The server must already be registered (via
// the admin API or the legacy env seed); its role + branding come from there.
//
// Requires the shared DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID, and the bot must
// have **Manage Channels** (plus the usual Send Messages + Embed Links). Set
// the server's portalUrl (admin API) to add the Verify buttons.
// ============================================================================

import { createDmzChannels } from "./channels.ts";
import {
  postAboutMessage,
  postHoneypotMessage,
  postRulesMessage,
  postVerifyMessage,
  type VerifyConfig,
} from "./mod.ts";
import { loadGuildToolConfig, toolGuildId } from "./config.ts";

export async function main(guildId: string = toolGuildId()) {
  const config = await loadGuildToolConfig(guildId);
  if (!config) {
    console.error(
      `Server ${guildId} isn't registered. Add it via the admin API first ` +
        `(POST /admin/guilds), then re-run setup.`,
    );
    return;
  }
  console.log(`Setting up DMZ for server ${guildId}…`);

  console.log("Creating DMZ channels…");
  for (const r of await createDmzChannels(config)) {
    const mark = r.status === "created" ? "+" : r.status === "exists" ? "=" : "✗";
    console.log(`  ${mark} ${r.name}: ${r.status}${r.id ? ` (${r.id})` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
  }

  // Post concurrently — each message's ID lives under its own blob key, so the
  // four writes don't race. (The channels exist by now, created above.)
  console.log("Posting DMZ messages…");
  const steps: [string, (c: VerifyConfig) => Promise<{ ok: boolean; detail: string }>][] = [
    ["about", postAboutMessage],
    ["rules", postRulesMessage],
    ["verify", postVerifyMessage],
    ["honeypot", postHoneypotMessage],
  ];
  const posted = await Promise.all(
    steps.map(([name, post]) =>
      post(config).then((res) => [name, res] as const)
    ),
  );
  for (const [name, res] of posted) {
    console.log(`  ${res.ok ? "✓" : "✗"} ${name}: ${res.detail}`);
  }

  console.log(
    "\nDone. Channel + message IDs are saved to blob — re-run any post-*.ts to edit a message in place.",
  );
}

await main();
