/**
 * Guarded admin API — register and manage shielded servers at runtime, so
 * onboarding a new Discord never needs a redeploy.
 *
 * All routes live under /admin/guilds and require a bearer token matching the
 * ADMIN_SECRET env var (constant-time compared). If ADMIN_SECRET is unset the
 * API is disabled entirely (404). Secrets are never echoed back in responses.
 *
 *   GET    /admin/guilds          list all servers
 *   POST   /admin/guilds          create a server (body: full config; 409 if it exists)
 *   GET    /admin/guilds/{id}     fetch one server
 *   PUT    /admin/guilds/{id}     create or replace a server
 *   PATCH  /admin/guilds/{id}     partially update an existing server
 *   DELETE /admin/guilds/{id}     remove a server
 *
 * Request/response bodies use the camelCase GuildInput/GuildConfig shape (see
 * guilds.ts). Branding (logo, colors, rules, about) and per-guild Turnstile
 * keys are all settable here.
 */

import {
  deleteGuild,
  getGuild,
  type GuildConfig,
  type GuildInput,
  listGuilds,
  upsertGuild,
} from "./guilds.ts";

// ========================================
// AUTH
// ========================================

/** Constant-time secret comparison via fixed-length SHA-256 digests (so neither
 *  length nor content leaks through timing). */
async function tokenMatches(provided: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

/** Extract the bearer token from the Authorization header. */
function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ========================================
// RESPONSES + VALIDATION
// ========================================

/** A validation/authorization failure carrying the HTTP status to return. */
class AdminError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const bad = (msg: string) => new AdminError(400, msg);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/** Hide the Turnstile secret from responses; report only whether one is set. */
function redact(g: GuildConfig): Record<string, unknown> {
  const { turnstileSecretKey, ...rest } = g;
  return { ...rest, hasTurnstileSecretKey: Boolean(turnstileSecretKey) };
}

const isSnowflake = (v: unknown): v is string =>
  typeof v === "string" && /^\d+$/.test(v);

function asString(v: unknown, key: string): string {
  if (typeof v !== "string") throw bad(`${key} must be a string`);
  return v;
}

function asBool(v: unknown, key: string): boolean {
  if (typeof v !== "boolean") throw bad(`${key} must be a boolean`);
  return v;
}

function asNumber(v: unknown, key: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw bad(`${key} must be a number`);
  }
  return n;
}

function asSnowflake(v: unknown, key: string): string {
  if (!isSnowflake(v)) throw bad(`${key} must be a numeric Discord ID`);
  return v;
}

function asColor(v: unknown, key: string): string {
  const s = asString(v, key);
  if (!/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s)) {
    throw bad(`${key} must be a hex color like #F4A340`);
  }
  return s.startsWith("#") ? s : `#${s}`;
}

/** Accept a Discord int color, a numeric string, or a #RRGGBB hex string. */
function asEmbedColor(v: unknown, key: string): number {
  if (typeof v === "string" && v.startsWith("#")) {
    const n = parseInt(v.slice(1), 16);
    if (Number.isNaN(n)) throw bad(`${key} must be a hex color`);
    return n;
  }
  return asNumber(v, key);
}

function asRules(v: unknown, key: string): { name: string; value: string }[] {
  if (!Array.isArray(v)) throw bad(`${key} must be an array`);
  return v.map((r, i) => {
    if (!r || typeof r !== "object") throw bad(`${key}[${i}] must be an object`);
    const o = r as Record<string, unknown>;
    return {
      name: asString(o.name, `${key}[${i}].name`),
      value: asString(o.value, `${key}[${i}].value`),
    };
  });
}

function asAbout(v: unknown, key: string) {
  if (!v || typeof v !== "object") throw bad(`${key} must be an object`);
  const o = v as Record<string, unknown>;
  return {
    tagline: asString(o.tagline, `${key}.tagline`),
    description: asString(o.description, `${key}.description`),
    highlights: asRules(o.highlights ?? [], `${key}.highlights`),
  };
}

// Per-field validators. A field present in the body (even as null) is processed;
// null clears the override. Absent fields are left untouched (PATCH-friendly).
const FIELDS: Record<keyof GuildInput, (v: unknown, k: string) => unknown> = {
  guildId: asSnowflake,
  roleId: asSnowflake,
  botRoleId: asSnowflake,
  serverName: asString,
  disabled: asBool,
  brandName: asString,
  logoUrl: asString,
  accentColor: asColor,
  accentColorBright: asColor,
  embedColor: asEmbedColor,
  ogHeadline: asString,
  ogTagline: asString,
  ogFallbackImage: asString,
  rules: asRules,
  about: asAbout,
  turnstileSiteKey: asString,
  turnstileSecretKey: asString,
  alertWebhookUrl: asString,
  raidThreshold: asNumber,
  raidWindowMs: asNumber,
  alertCooldownMs: asNumber,
  verifyChannelId: asString,
  rulesChannelId: asString,
  aboutChannelId: asString,
  honeypotChannelId: asString,
  portalUrl: asString,
  redirectUriOverride: asString,
};

/** Read + validate only the GuildInput fields present in the body. A field set
 *  to null becomes undefined (clear the override). Unknown keys are ignored. */
function readGuildFields(body: Record<string, unknown>): Partial<GuildInput> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(FIELDS) as (keyof GuildInput)[]) {
    if (!(key in body)) continue;
    const raw = body[key];
    out[key] = raw === null ? undefined : FIELDS[key](raw, key);
  }
  return out as Partial<GuildInput>;
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw bad("Body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw bad("Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Drop server-managed timestamps so a fetched config can seed an update. */
function toInput(g: GuildConfig): GuildInput {
  const { createdAt: _c, updatedAt: _u, ...input } = g;
  return input;
}

// ========================================
// ROUTER
// ========================================

/**
 * Handle an /admin request. `secret` is the configured ADMIN_SECRET (undefined
 * disables the API). Returns null only if the path isn't an admin path, so the
 * caller can fall through to other routes.
 */
export async function handleAdminRequest(
  req: Request,
  url: URL,
  secret: string | undefined,
): Promise<Response | null> {
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["admin","guilds","123"]
  if (parts[0] !== "admin") return null;

  // API disabled when no secret is configured — don't reveal it exists.
  if (!secret) return json({ error: "Not found." }, 404);

  const token = bearer(req);
  if (!token || !(await tokenMatches(token, secret))) {
    return new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      },
    });
  }

  if (parts[1] !== "guilds") return json({ error: "Not found." }, 404);
  const id = parts[2];

  try {
    // Collection: /admin/guilds
    if (parts.length === 2) {
      if (req.method === "GET") {
        return json({ guilds: (await listGuilds()).map(redact) });
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const fields = readGuildFields(body);
        if (!isSnowflake(fields.guildId)) throw bad("guildId is required.");
        if (!isSnowflake(fields.roleId)) throw bad("roleId is required.");
        if (await getGuild(fields.guildId)) {
          throw new AdminError(
            409,
            `Server ${fields.guildId} already exists — use PUT or PATCH.`,
          );
        }
        await upsertGuild(fields as GuildInput);
        const saved = await getGuild(fields.guildId);
        return json(saved ? redact(saved) : {}, 201);
      }
      return json({ error: "Method not allowed." }, 405);
    }

    // Item: /admin/guilds/{id}
    if (parts.length === 3 && id) {
      if (req.method === "GET") {
        const g = await getGuild(id);
        return g ? json(redact(g)) : json({ error: "Not found." }, 404);
      }
      if (req.method === "PUT") {
        const body = await parseBody(req);
        const fields = readGuildFields(body);
        // Path id is authoritative.
        const merged = { ...fields, guildId: id } as GuildInput;
        if (!isSnowflake(merged.roleId)) throw bad("roleId is required.");
        await upsertGuild(merged);
        const saved = await getGuild(id);
        return json(saved ? redact(saved) : {});
      }
      if (req.method === "PATCH") {
        const existing = await getGuild(id);
        if (!existing) return json({ error: "Not found." }, 404);
        const body = await parseBody(req);
        const fields = readGuildFields(body);
        // Overlay the patch on the existing config; path id stays authoritative.
        const merged = { ...toInput(existing), ...fields, guildId: id };
        await upsertGuild(merged);
        const saved = await getGuild(id);
        return json(saved ? redact(saved) : {});
      }
      if (req.method === "DELETE") {
        if (!(await getGuild(id))) return json({ error: "Not found." }, 404);
        await deleteGuild(id);
        return json({ deleted: id });
      }
      return json({ error: "Method not allowed." }, 405);
    }

    return json({ error: "Not found." }, 404);
  } catch (e) {
    if (e instanceof AdminError) return json({ error: e.message }, e.status);
    console.error("admin error:", e);
    return json({ error: "Internal error." }, 500);
  }
}
