import type { ChatDescriptor, ChatRef } from "./index.js";

export const CONVERSATION_SETTING_FIELDS = [
  "enabled",
  "activation.mode",
  "activation.botMessages",
  "activation.whenOthersMentioned",
  "replies.placement",
  "routing.agentName",
  "session.reset",
] as const;

export type ChatSettingField = (typeof CONVERSATION_SETTING_FIELDS)[number];

export type ProviderSessionResetPolicy =
  | { mode: "none" }
  | { mode: "idle"; idleMinutes: number }
  | { mode: "daily"; atHour: number };

export interface ChatSettings {
  enabled: boolean;
  activation: {
    mode: "mention" | "all";
    botMessages: "ignore" | "mentions" | "all";
    whenOthersMentioned: "ignore" | "respond";
  };
  replies: { placement: "thread" | "inline" };
  routing: { agentName: string | null };
  session: { reset: ProviderSessionResetPolicy };
}

export interface ChatSettingsOverrides {
  enabled?: boolean;
  activation?: Partial<ChatSettings["activation"]>;
  replies?: Partial<ChatSettings["replies"]>;
  routing?: Partial<ChatSettings["routing"]>;
  session?: { reset?: ProviderSessionResetPolicy };
}

export type PartialChatSettings = ChatSettingsOverrides;

export interface SettingsActor {
  kind: "guardian" | "system";
  id?: string;
  displayName?: string;
}

export interface ChatSettingsSnapshot {
  conversation: ChatDescriptor;
  supportedFields: readonly ChatSettingField[];
  effective: ChatSettings;
  overrides: ChatSettingsOverrides;
  /** Present on thread/topic reads. Such conversations have no direct
   * overrides and resolve all effective values from this settings owner. */
  inheritedFrom?: ChatRef;
  updatedAt?: string;
  updatedBy?: SettingsActor;
}

export interface ChatSettingsListItem {
  snapshot: ChatSettingsSnapshot;
  availability: "online" | "offline" | "not-connected";
  source: "live" | "known" | "configured";
}

export interface ChatSettingsPage {
  items: ChatSettingsListItem[];
  nextCursor?: string;
}

export interface ListChatSettingsInput {
  connectionId?: string;
  query?: string;
  cursor?: string;
  limit?: number;
  availability?: ChatSettingsListItem["availability"];
}

export interface UpdateChatSettingsInput {
  ref: ChatRef;
  set: PartialChatSettings;
  clear: ChatSettingField[];
  actor: SettingsActor;
}

export interface ResetChatSettingsInput {
  ref: ChatRef;
  actor: SettingsActor;
}

export interface ChatSettingsControl {
  list(input: ListChatSettingsInput): Promise<ChatSettingsPage>;
  get(ref: ChatRef): Promise<ChatSettingsSnapshot>;
  update(input: UpdateChatSettingsInput): Promise<ChatSettingsSnapshot>;
  reset(input: ResetChatSettingsInput): Promise<ChatSettingsSnapshot>;
}

export interface StoredChatSettings {
  schemaVersion: 1;
  /** Policy overrides plus an optional explicit-main marker. Named routing
   * values live only in `rome_sessions.agent_name`. */
  overrides: ChatSettingsOverrides;
  updatedAt: string;
  updatedBy: SettingsActor;
}

/** @deprecated Use `ChatSettingField`. */
export type ConversationSettingField = ChatSettingField;
/** @deprecated Use `ChatSettings`. */
export type ConversationSettings = ChatSettings;
/** @deprecated Use `ChatSettingsOverrides`. */
export type ConversationSettingsOverrides = ChatSettingsOverrides;
/** @deprecated Use `PartialChatSettings`. */
export type PartialConversationSettings = PartialChatSettings;
/** @deprecated Use `ChatSettingsSnapshot`. */
export type ConversationSettingsSnapshot = ChatSettingsSnapshot;
/** @deprecated Use `ChatSettingsListItem`. */
export type ConversationSettingsListItem = ChatSettingsListItem;
/** @deprecated Use `ChatSettingsPage`. */
export type ConversationSettingsPage = ChatSettingsPage;
/** @deprecated Use `ListChatSettingsInput`. */
export type ListConversationSettingsInput = ListChatSettingsInput;
/** @deprecated Use `UpdateChatSettingsInput`. */
export type UpdateConversationSettingsInput = UpdateChatSettingsInput;
/** @deprecated Use `ResetChatSettingsInput`. */
export type ResetConversationSettingsInput = ResetChatSettingsInput;
/** @deprecated Use `ChatSettingsControl`. */
export type ConversationSettingsControl = ChatSettingsControl;
/** @deprecated Use `StoredChatSettings`. */
export type StoredConversationSettings = StoredChatSettings;
