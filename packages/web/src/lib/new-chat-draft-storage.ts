import { z } from "zod";
import { DEFAULT_PROJECT_NAME } from "@/lib/chat-constants";
import { draftDeviceFolderSchema } from "@/lib/device-folder";
import { randomUUID } from "./random-uuid";

const KEY = "rome:new-chat-draft";
const AUTH_EPOCH_KEY = "rome:auth-epoch";
const schema = z.object({
  version: z.literal(1),
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
  // Optional, so drafts saved before device folders existed still load.
  deviceFolder: draftDeviceFolderSchema.nullable().optional(),
});
const recordSchema = schema.extend({ authEpoch: z.string().default("") });
export type NewChatDraft = z.infer<typeof schema>;

export function currentAuthEpoch(): string | null {
  try {
    return localStorage.getItem(AUTH_EPOCH_KEY) ?? "";
  } catch {
    return null;
  }
}

export function loadNewChatDraft(): NewChatDraft | null {
  try {
    const result = recordSchema.safeParse(JSON.parse(sessionStorage.getItem(KEY) ?? "null"));
    if (!result.success) return null;
    const { authEpoch, ...draft } = result.data;
    if (authEpoch !== currentAuthEpoch()) {
      clearNewChatDraft();
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function saveNewChatDraft(draft: NewChatDraft, authEpoch = currentAuthEpoch()) {
  if (
    !draft.text &&
    draft.projectPath === DEFAULT_PROJECT_NAME &&
    !draft.agentMention &&
    !draft.skill &&
    !draft.personaId &&
    !draft.deviceFolder
  ) {
    clearNewChatDraft();
    return;
  }
  try {
    if (authEpoch === null || authEpoch !== currentAuthEpoch()) {
      clearNewChatDraft();
      return;
    }
    sessionStorage.setItem(KEY, JSON.stringify({ ...draft, authEpoch }));
  } catch {
    // Disabled storage must not break editing.
  }
}

export function clearNewChatDraft() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Disabled storage must not break editing or logout.
  }
}

/** Invalidates drafts in every tab when they next load, without sharing their content. */
export function invalidateNewChatDrafts() {
  clearNewChatDraft();
  try {
    localStorage.setItem(AUTH_EPOCH_KEY, randomUUID());
  } catch {
    // Disabled storage must not break logout.
  }
}
