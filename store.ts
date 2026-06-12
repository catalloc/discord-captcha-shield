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
 * Channel-ID resolution order (see mod.ts `resolveChannel`) is:
 *   explicit parameter  ->  this store  ->  the env var (config field)
 * so a server that ran setup.ts uses the bot-made channels, while a server that
 * wired channel IDs by hand still works via env.
 */

import { blob } from "https://esm.town/v/std/blob";

const PREFIX = "captcha_shield_v1";

export type ChannelKind = "about" | "rules" | "verify" | "honeypot";

const channelKey = (kind: ChannelKind) => `${PREFIX}_channel_${kind}`;
const messageKey = (kind: ChannelKind) => `${PREFIX}_message_${kind}`;
const CATEGORY_KEY = `${PREFIX}_category`;

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

export const getChannel = (kind: ChannelKind): Promise<string | undefined> =>
  readId(channelKey(kind));
export const getMessage = (kind: ChannelKind): Promise<string | undefined> =>
  readId(messageKey(kind));
export const getCategory = (): Promise<string | undefined> =>
  readId(CATEGORY_KEY);

export const rememberChannel = (kind: ChannelKind, id: string): Promise<void> =>
  writeId(channelKey(kind), id);
export const rememberMessage = (kind: ChannelKind, id: string): Promise<void> =>
  writeId(messageKey(kind), id);
export const rememberCategory = (id: string): Promise<void> =>
  writeId(CATEGORY_KEY, id);
