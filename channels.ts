/**
 * One-shot creation of the DMZ channels the shield posts into.
 *
 * Run via setup.ts. Creates a category + four text channels (about, rules,
 * verify, honeypot) with sensible @everyone permission overwrites, and stores
 * every ID in the blob store so the post tools find them automatically and the
 * run is idempotent (re-running skips channels that still exist).
 *
 * Requires the bot to have **Manage Channels** (in addition to the permissions
 * the rest of the shield needs). The shield never creates channels on its own —
 * only this explicit setup path does.
 */

import type { VerifyConfig } from "./mod.ts";
import {
  type ChannelKind,
  getCategory,
  getChannel,
  rememberCategory,
  rememberChannel,
} from "./store.ts";

const DISCORD_API = "https://discord.com/api/v10";

// Discord permission bits (as strings, since they're 53-bit-safe here).
const VIEW_CHANNEL = 1 << 10; // 1024
const SEND_MESSAGES = 1 << 11; // 2048
const EMBED_LINKS = 1 << 14; // 16384

const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_CATEGORY = 4;
const OVERWRITE_ROLE = 0;
const OVERWRITE_MEMBER = 1;

interface ChannelSpec {
  kind: ChannelKind;
  name: string;
  topic: string;
  /** Honeypot lets @everyone post (that's the trap); the rest are read-only. */
  everyoneCanSend: boolean;
}

const DMZ_CHANNELS: ChannelSpec[] = [
  {
    kind: "about",
    name: "about",
    topic: "What this community is about. Read before you verify.",
    everyoneCanSend: false,
  },
  {
    kind: "rules",
    name: "rules",
    topic: "The server rules. By being here you agree to them.",
    everyoneCanSend: false,
  },
  {
    kind: "verify",
    name: "verify",
    topic: "Click Verify, pass a quick CAPTCHA, and the server unlocks.",
    everyoneCanSend: false,
  },
  {
    kind: "honeypot",
    name: "do-not-post",
    topic: "Do not post here. This channel is a spam trap.",
    everyoneCanSend: true,
  },
];

const CATEGORY_NAME = "Welcome";

export interface CreateResult {
  kind: ChannelKind | "category";
  name: string;
  status: "created" | "exists" | "failed";
  id?: string;
  detail?: string;
}

function authHeaders(config: VerifyConfig): HeadersInit {
  return {
    authorization: `Bot ${config.botToken}`,
    "content-type": "application/json",
  };
}

/** True if a channel with this ID still exists and the bot can see it. */
async function channelExists(config: VerifyConfig, id: string): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/channels/${id}`, {
    headers: authHeaders(config),
  });
  return res.ok;
}

/** Overwrites that make a channel visible to everyone but writable only by the
 *  bot (read-only), or writable by everyone (the honeypot trap). The bot always
 *  keeps an explicit allow so a read-only @everyone deny can't mute it. */
function overwritesFor(config: VerifyConfig, everyoneCanSend: boolean) {
  const everyoneAllow = VIEW_CHANNEL | (everyoneCanSend ? SEND_MESSAGES : 0);
  const everyoneDeny = everyoneCanSend ? 0 : SEND_MESSAGES;
  return [
    {
      id: config.guildId, // @everyone role id == guild id
      type: OVERWRITE_ROLE,
      allow: String(everyoneAllow),
      deny: String(everyoneDeny),
    },
    {
      id: config.clientId, // a bot's user id == its application/client id
      type: OVERWRITE_MEMBER,
      allow: String(VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS),
      deny: "0",
    },
  ];
}

/** Ensure the DMZ category exists; return its ID (or "" if creation failed). */
async function ensureCategory(
  config: VerifyConfig,
  results: CreateResult[],
): Promise<string> {
  const existing = await getCategory();
  if (existing && await channelExists(config, existing)) {
    results.push({
      kind: "category",
      name: CATEGORY_NAME,
      status: "exists",
      id: existing,
    });
    return existing;
  }

  const res = await fetch(`${DISCORD_API}/guilds/${config.guildId}/channels`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ name: CATEGORY_NAME, type: CHANNEL_TYPE_CATEGORY }),
  });
  if (!res.ok) {
    results.push({
      kind: "category",
      name: CATEGORY_NAME,
      status: "failed",
      detail: `Discord ${res.status}: ${(await res.text()).slice(0, 200)}`,
    });
    return "";
  }
  const created = await res.json();
  await rememberCategory(created.id);
  results.push({
    kind: "category",
    name: CATEGORY_NAME,
    status: "created",
    id: created.id,
  });
  return created.id;
}

/** Create (or confirm) one DMZ channel, storing its ID in blob. */
async function ensureChannel(
  config: VerifyConfig,
  spec: ChannelSpec,
  parentId: string,
): Promise<CreateResult> {
  const existingId = await getChannel(spec.kind);
  if (existingId && await channelExists(config, existingId)) {
    return { kind: spec.kind, name: spec.name, status: "exists", id: existingId };
  }

  const body: Record<string, unknown> = {
    name: spec.name,
    type: CHANNEL_TYPE_TEXT,
    topic: spec.topic,
    permission_overwrites: overwritesFor(config, spec.everyoneCanSend),
  };
  if (parentId) body.parent_id = parentId;

  const res = await fetch(`${DISCORD_API}/guilds/${config.guildId}/channels`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return {
      kind: spec.kind,
      name: spec.name,
      status: "failed",
      detail: `Discord ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }
  const created = await res.json();
  await rememberChannel(spec.kind, created.id);
  return { kind: spec.kind, name: spec.name, status: "created", id: created.id };
}

/**
 * Create (or confirm) the DMZ category + channels, storing every ID in blob.
 * Idempotent: a channel already recorded and still present is left untouched.
 * The category is created first (channels nest under it); the channels then go
 * up concurrently — safe because each writes its own per-kind blob key.
 */
export async function createDmzChannels(
  config: VerifyConfig,
): Promise<CreateResult[]> {
  const results: CreateResult[] = [];
  const parentId = await ensureCategory(config, results);

  const channelResults = await Promise.all(
    DMZ_CHANNELS.map((spec) => ensureChannel(config, spec, parentId)),
  );
  results.push(...channelResults);
  return results;
}
