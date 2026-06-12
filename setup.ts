// ============================================================================
// One-shot DMZ bootstrap (manual trigger)
// ============================================================================
//
// Run this file ONCE (Val Town "Run" button) to stand up the whole DMZ:
//   1. Creates a "Welcome" category + #about, #rules, #verify, #do-not-post
//      channels with read-only @everyone overwrites (the honeypot stays open).
//   2. Posts the about / rules / verify / honeypot messages into them.
// Every channel + message ID is saved to blob storage, so re-running any
// post-*.ts afterwards EDITS its message in place instead of duplicating, and
// re-running setup.ts skips channels that already exist.
//
// Requires: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_CLIENT_ID, and the bot
// must have **Manage Channels** (plus the usual Send Messages + Embed Links).
// Optional: VERIFY_SERVER_NAME, VERIFY_PORTAL_URL (adds the Verify buttons).
//
// Already have channels? Skip this — set the DISCORD_*_CHANNEL_ID env vars and
// run the individual post-*.ts scripts instead.
// ============================================================================

import { createDmzChannels } from "./channels.ts";
import {
  postAboutMessage,
  postHoneypotMessage,
  postRulesMessage,
  postVerifyMessage,
  type VerifyConfig,
} from "./mod.ts";
import { env, optEnv } from "./config.ts";

export async function main() {
  const redirect = optEnv("VERIFY_REDIRECT_URI");
  const config = {
    botToken: env("DISCORD_BOT_TOKEN"),
    guildId: env("DISCORD_GUILD_ID"),
    clientId: env("DISCORD_CLIENT_ID"),
    serverName: optEnv("VERIFY_SERVER_NAME"),
    portalUrl: optEnv("VERIFY_PORTAL_URL") ??
      (redirect ? redirect.replace(/\/callback$/, "") : undefined),
  } as VerifyConfig;

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
