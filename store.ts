/**
 * Per-key blob storage for the IDs the shield owns: the DMZ category, the four
 * DMZ channels, and the messages it posts into them.
 *
 * Persisting these gives two things:
 *   1. Idempotent setup — channel creation can skip channels it already made.
 *   2. In-place message updates — re-running a post tool EDITS the message it
 *      posted last time instead of dropping a duplicate.
 *
 * Each ID lives under its OWN blob key (one channel, one message, one category
 * per key) rather than in a single aggregate object. That makes writes
 * independent: setup.ts can post all four DMZ messages concurrently without the
 * read-modify-write races a shared object would have.
 *
 * Multi-tenant: every key is namespaced by guild id, so each shielded server
 * owns an isolated set of channel/message/category IDs in the shared store.
 *
 * Channel-ID resolution order (see mod.ts `resolveChannel`) is:
 *   explicit parameter  ->  this store  ->  the per-guild config field
 * so a server that ran setup.ts uses the bot-made channels, while a server that
 * wired channel IDs by hand still works via its config.
 */

import { blob } from "https://esm.town/v/std/blob";

const PREFIX = "captcha_shield_v1";

export type ChannelKind = "about" | "rules" | "verify" | "honeypot";

const channelKey = (guildId: string, kind: ChannelKind) =>
  `${PREFIX}_${guildId}_channel_${kind}`;
const messageKey = (guildId: string, kind: ChannelKind) =>
  `${PREFIX}_${guildId}_message_${kind}`;
const categoryKey = (guildId: string) => `${PREFIX}_${guildId}_category`;

/** Read a single stored ID. Undefined if it was never written. */
async function readId(key: string): Promise<string | undefined> {
  try {
    const res = await blob.get(key);
    const text = (await res.text()).trim();
    return text || undefined;
  } catch {
    return undefined; // not written yet
  }
}

/** Write a single stored ID. One key per ID, so concurrent writes don't race. */
async function writeId(key: string, id: string): Promise<void> {
  await blob.set(key, id);
}

export const getChannel = (
  guildId: string,
  kind: ChannelKind,
): Promise<string | undefined> => readId(channelKey(guildId, kind));
export const getMessage = (
  guildId: string,
  kind: ChannelKind,
): Promise<string | undefined> => readId(messageKey(guildId, kind));
export const getCategory = (guildId: string): Promise<string | undefined> =>
  readId(categoryKey(guildId));

export const rememberChannel = (
  guildId: string,
  kind: ChannelKind,
  id: string,
): Promise<void> => writeId(channelKey(guildId, kind), id);
export const rememberMessage = (
  guildId: string,
  kind: ChannelKind,
  id: string,
): Promise<void> => writeId(messageKey(guildId, kind), id);
export const rememberCategory = (
  guildId: string,
  id: string,
): Promise<void> => writeId(categoryKey(guildId), id);

const KINDS: ChannelKind[] = ["about", "rules", "verify", "honeypot"];

/**
 * Migrate IDs written by the single-guild build (un-namespaced keys like
 * `captcha_shield_v1_channel_verify`) to this guild's namespaced keys. Copies
 * the category, four channel IDs, and four message IDs — but never clobbers a
 * value already present under the new key. Best-effort and idempotent; called
 * once from the legacy-env migration so post tools keep editing in place.
 */
export async function migrateLegacyKeys(guildId: string): Promise<void> {
  const copy = async (oldKey: string, newKey: string) => {
    if (await readId(newKey)) return; // already migrated / set
    const val = await readId(oldKey);
    if (val) await writeId(newKey, val);
  };
  const jobs = [copy(`${PREFIX}_category`, categoryKey(guildId))];
  for (const k of KINDS) {
    jobs.push(copy(`${PREFIX}_channel_${k}`, channelKey(guildId, k)));
    jobs.push(copy(`${PREFIX}_message_${k}`, messageKey(guildId, k)));
  }
  await Promise.all(jobs);
}
