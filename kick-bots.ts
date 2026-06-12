// ============================================================================
// Discord CAPTCHA Shield — kick self-identified bots (Val Town Cron)
// ============================================================================
//
// A Discord Onboarding "prejoin question" can ask new members whether they're a
// bot / automated. Members who answer affirmatively get a "self-identified bot"
// role (set per server as `botRoleId` via the admin API); members who answer
// "no" get your Unverified role, which reveals the #verify portal. This cron
// sweeps every server that has a `botRoleId` configured and KICKS members still
// holding that role. A short grace skips brand-new joins (mid-onboarding) so a
// human who just mis-clicked has a moment to fix it.
//
// Set this file as a Cron val on a frequent-ish schedule (e.g. every 15 min:
// `*/15 * * * *`). Requires, in addition to the shield's usual permissions:
//   - the **GUILD_MEMBERS** privileged intent (Developer Portal → Bot) so the
//     bot can list guild members, and
//   - the **Kick Members** permission in each server.
// ============================================================================

import { listGuilds } from "./guilds.ts";
import { loadSharedEnv } from "./config.ts";

const DISCORD_API = "https://discord.com/api/v10";
const PAGE = 1000; // max members Discord returns per list page
const GRACE_MS = 5 * 60 * 1000; // skip members who joined < 5 min ago

interface GuildMember {
  user?: { id: string };
  roles: string[];
  joined_at: string;
}

/** Discord REST with a single 429 retry honoring retry-after. */
async function discord(
  path: string,
  init: RequestInit,
  botToken: string,
): Promise<Response> {
  const url = `${DISCORD_API}${path}`;
  const headers = { ...(init.headers ?? {}), authorization: `Bot ${botToken}` };
  let res = await fetch(url, { ...init, headers });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.min(retry, 10) * 1000 + 250));
    res = await fetch(url, { ...init, headers });
  }
  return res;
}

/** Page through guild members, returning the IDs holding `roleId` past grace. */
async function membersWithRole(
  botToken: string,
  guildId: string,
  roleId: string,
  now: number,
): Promise<string[]> {
  const ids: string[] = [];
  let after = "0";
  for (;;) {
    const res = await discord(
      `/guilds/${guildId}/members?limit=${PAGE}&after=${after}`,
      { method: "GET" },
      botToken,
    );
    if (!res.ok) {
      console.error(
        `kick-bots: list failed for ${guildId}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
      break;
    }
    const page = await res.json() as GuildMember[];
    if (!Array.isArray(page) || page.length === 0) break;
    for (const m of page) {
      const id = m.user?.id;
      if (!id || !m.roles?.includes(roleId)) continue;
      const joined = Date.parse(m.joined_at);
      if (Number.isFinite(joined) && now - joined < GRACE_MS) continue; // grace
      ids.push(id);
    }
    const last = page[page.length - 1].user?.id;
    if (page.length < PAGE || !last || last === after) break; // last page / no progress
    after = last;
  }
  return ids;
}

/**
 * Kick every member of `guildId` holding `roleId`. Returns counts. Exported so
 * it can be invoked directly for one server; the cron loops all servers.
 */
export async function kickIdentifiedBots(
  botToken: string,
  guildId: string,
  roleId: string,
  now: number = Date.now(),
): Promise<{ kicked: number; failed: number }> {
  const ids = await membersWithRole(botToken, guildId, roleId, now);
  let kicked = 0;
  let failed = 0;
  for (const id of ids) {
    const res = await discord(
      `/guilds/${guildId}/members/${id}`,
      {
        method: "DELETE",
        headers: {
          "x-audit-log-reason":
            "Self-identified as a bot (CAPTCHA Shield onboarding trap)",
        },
      },
      botToken,
    );
    if (res.status === 204) {
      kicked++;
    } else {
      failed++;
      console.error(
        `kick-bots: kick ${id} in ${guildId} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
  }
  return { kicked, failed };
}

export default async function () {
  const { botToken } = loadSharedEnv();
  const now = Date.now();
  for (const g of await listGuilds()) {
    if (g.disabled || !g.botRoleId) continue;
    try {
      const { kicked, failed } = await kickIdentifiedBots(
        botToken,
        g.guildId,
        g.botRoleId,
        now,
      );
      if (kicked || failed) {
        console.log(`kick-bots[${g.guildId}]: kicked ${kicked}, failed ${failed}`);
      }
    } catch (e) {
      console.error(`kick-bots: error for ${g.guildId}:`, e);
    }
  }
}
