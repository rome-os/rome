import { z } from "zod";
import { randomUUID } from "./random-uuid";

const PREFIX = "rome:new-chat-draft:";
const OWNER = PREFIX + "owner";
const INTENTS = PREFIX + "intents";
export const DRAFT_RESTORED_EVENT = "rome:new-chat-draft-restored";
export const DRAFT_RESET_EVENT = "rome:new-chat-draft-reset";

const contextField = z.enum(["projectPath", "agentMention", "skill", "personaId"]);
const dataSchema = z.object({
  text: z.string(),
  projectPath: z.string(),
  agentMention: z
    .object({
      appId: z.string(),
      agentName: z.string(),
      appLabel: z.string(),
      iconUrl: z.string().nullable().optional(),
    })
    .nullable(),
  skill: z
    .object({
      name: z.string(),
      localName: z.string().optional(),
      description: z.string().optional(),
      iconUrl: z.string().nullable().optional(),
    })
    .nullable(),
  personaId: z.string(),
  // Passive seeds may follow earlier seeds, but not explicit picker choices.
  manual: z.array(contextField),
});
const recordSchema = z.object({ version: z.literal(1), revision: z.string(), value: dataSchema });
export type NewChatDraftData = z.infer<typeof dataSchema>;
export type DraftRecord = z.infer<typeof recordSchema>;
export const emptyNewChatDraft = (): NewChatDraftData => ({
  text: "",
  projectPath: "default",
  agentMention: null,
  skill: null,
  personaId: "",
  manual: [],
});
const key = (owner: string) => PREFIX + "draft:" + encodeURIComponent(owner);

export function activeDraftOwner(): string | null {
  try {
    return sessionStorage.getItem(OWNER);
  } catch {
    return null;
  }
}

/** Drops content and invalidates late writes, but keeps opaque consumed-navigation receipts. */
export function clearNewChatDrafts(notify = true) {
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    for (const entry of keys)
      if (entry?.startsWith(PREFIX + "draft:") || entry === OWNER) sessionStorage.removeItem(entry);
  } catch {
    /* Disabled storage must not break logout or local editing. */
  }
  if (notify) window.dispatchEvent(new Event(DRAFT_RESET_EVENT));
}

export function activateDraftOwner(owner: string) {
  if (activeDraftOwner() === owner) return;
  clearNewChatDrafts(activeDraftOwner() !== null);
  try {
    sessionStorage.setItem(OWNER, owner);
  } catch {
    /* Local-only fallback. */
  }
}

export function readNewChatDraft(owner: string): DraftRecord | null {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(sessionStorage.getItem(key(owner)) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeNewChatDraft(owner: string, value: NewChatDraftData): DraftRecord | null {
  if (activeDraftOwner() !== owner) return null;
  const record: DraftRecord = { version: 1, revision: randomUUID(), value };
  try {
    sessionStorage.setItem(key(owner), JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}

/** A missing/changed revision is not permission to restore, even when its text is empty. */
export function restoreNewChatDraft(owner: string, revision: string, value: NewChatDraftData) {
  if (activeDraftOwner() !== owner || readNewChatDraft(owner)?.revision !== revision) return false;
  if (!writeNewChatDraft(owner, value)) return false;
  window.dispatchEvent(new CustomEvent(DRAFT_RESTORED_EVENT, { detail: owner }));
  return true;
}

export function consumeDraftIntent(intent: string): boolean {
  try {
    const parsed = z
      .array(z.string())
      .safeParse(JSON.parse(sessionStorage.getItem(INTENTS) ?? "[]"));
    const receipts = new Set(parsed.success ? parsed.data : []);
    if (receipts.has(intent)) return false;
    receipts.add(intent);
    sessionStorage.setItem(INTENTS, JSON.stringify([...receipts]));
  } catch {
    /* The mounted hook still consumes each intent locally. */
  }
  return true;
}
