import type {
  ConversationDescriptor,
  ConversationId,
  ConversationRef,
  ConversationSettingField,
  ConversationSettings,
  ConversationSettingsControl,
  ConversationSettingsListItem,
  ConversationSettingsOverrides,
  ConversationSettingsPage,
  ConversationSettingsSnapshot,
  ListConversationSettingsInput,
  PartialConversationSettings,
  ResetConversationSettingsInput,
  SettingsActor,
  StoredConversationSettings,
  UpdateConversationSettingsInput,
} from "@rome-os/app-runtime";
import { CONVERSATION_SETTING_FIELDS } from "@rome-os/app-runtime";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { createLogger } from "../logger.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import type { Channels } from "../channels/channel.js";
import type { StoredConversationRow } from "./repository.js";
import { ConversationSettingsRepository } from "./repository.js";
import {
  CONVERSATION_SETTING_FIELDS_BY_SERVICE,
  CORE_CONVERSATION_SETTING_FIELDS,
  defaultConversationSettings,
} from "./support.js";
import { assertProviderSessionResetPolicy } from "./reset-policy.js";

const log = createLogger("conversation-settings");

function fieldValue(settings: ConversationSettingsOverrides, field: ConversationSettingField) {
  switch (field) {
    case "enabled":
      return settings.enabled;
    case "activation.mode":
      return settings.activation?.mode;
    case "activation.botMessages":
      return settings.activation?.botMessages;
    case "activation.whenOthersMentioned":
      return settings.activation?.whenOthersMentioned;
    case "replies.placement":
      return settings.replies?.placement;
    case "routing.agentName":
      return settings.routing?.agentName;
    case "session.reset":
      return settings.session?.reset;
  }
}

function setField(
  settings: ConversationSettingsOverrides,
  field: ConversationSettingField,
  value: unknown,
): void {
  switch (field) {
    case "enabled":
      settings.enabled = value as boolean;
      return;
    case "activation.mode":
      (settings.activation ??= {}).mode = value as ConversationSettings["activation"]["mode"];
      return;
    case "activation.botMessages":
      (settings.activation ??= {}).botMessages =
        value as ConversationSettings["activation"]["botMessages"];
      return;
    case "activation.whenOthersMentioned":
      (settings.activation ??= {}).whenOthersMentioned =
        value as ConversationSettings["activation"]["whenOthersMentioned"];
      return;
    case "replies.placement":
      (settings.replies ??= {}).placement = value as ConversationSettings["replies"]["placement"];
      return;
    case "routing.agentName":
      (settings.routing ??= {}).agentName = value as string | null;
      return;
    case "session.reset":
      (settings.session ??= {}).reset = structuredClone(
        value as ConversationSettings["session"]["reset"],
      );
  }
}

function clearField(
  settings: ConversationSettingsOverrides,
  field: ConversationSettingField,
): void {
  switch (field) {
    case "enabled":
      delete settings.enabled;
      break;
    case "activation.mode":
      if (settings.activation) delete settings.activation.mode;
      break;
    case "activation.botMessages":
      if (settings.activation) delete settings.activation.botMessages;
      break;
    case "activation.whenOthersMentioned":
      if (settings.activation) delete settings.activation.whenOthersMentioned;
      break;
    case "replies.placement":
      if (settings.replies) delete settings.replies.placement;
      break;
    case "routing.agentName":
      if (settings.routing) delete settings.routing.agentName;
      break;
    case "session.reset":
      if (settings.session) delete settings.session.reset;
      break;
  }
  if (settings.activation && Object.keys(settings.activation).length === 0)
    delete settings.activation;
  if (settings.replies && Object.keys(settings.replies).length === 0) delete settings.replies;
  if (settings.routing && Object.keys(settings.routing).length === 0) delete settings.routing;
  if (settings.session && Object.keys(settings.session).length === 0) delete settings.session;
}

function overlay(base: ConversationSettings, overrides: ConversationSettingsOverrides) {
  const result = structuredClone(base);
  for (const field of CONVERSATION_SETTING_FIELDS) {
    const value = fieldValue(overrides, field);
    if (value !== undefined) setField(result, field, value);
  }
  return result;
}

function normalizeOverrides(value: ConversationSettingsOverrides): ConversationSettingsOverrides {
  const result: ConversationSettingsOverrides = {};
  for (const field of CONVERSATION_SETTING_FIELDS) {
    const current = fieldValue(value, field);
    if (current !== undefined) setField(result, field, current);
  }
  return result;
}

function assertActor(actor: SettingsActor): void {
  if (actor.kind !== "guardian" && actor.kind !== "system") {
    throw new Error("Conversation settings require a guardian or system actor");
  }
}

function assertKnownSetShape(value: PartialConversationSettings): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Conversation settings set must be an object");
  }
  const groups: Record<string, readonly string[] | null> = {
    enabled: null,
    activation: ["mode", "botMessages", "whenOthersMentioned"],
    replies: ["placement"],
    routing: ["agentName"],
    session: ["reset"],
  };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(groups, key)) {
      throw new Error(`Unsupported conversation setting "${key}"`);
    }
    const nested = groups[key];
    if (nested === null) continue;
    const group = (value as Record<string, unknown>)[key];
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new Error(`Conversation setting "${key}" must be an object`);
    }
    for (const child of Object.keys(group)) {
      if (!nested.includes(child)) {
        throw new Error(`Unsupported conversation setting "${key}.${child}"`);
      }
    }
  }
}

function assertValue(field: ConversationSettingField, value: unknown): void {
  if (field === "session.reset") {
    assertProviderSessionResetPolicy(value);
    return;
  }
  const allowed: Record<Exclude<ConversationSettingField, "session.reset">, readonly unknown[]> = {
    enabled: [true, false],
    "activation.mode": ["mention", "all"],
    "activation.botMessages": ["ignore", "mentions", "all"],
    "activation.whenOthersMentioned": ["ignore", "respond"],
    "replies.placement": ["thread", "inline"],
    "routing.agentName": [null],
  };
  if (field === "routing.agentName") {
    if (value === null || (typeof value === "string" && value.trim().length > 0)) return;
  } else if (allowed[field].includes(value)) {
    return;
  }
  throw new Error(`Invalid value for conversation setting "${field}"`);
}

function cursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export interface ConversationSettingsServiceDeps {
  repository: ConversationSettingsRepository;
  connections: ConnectionRegistry;
  /** The channels whose directories list live conversations. Undefined until
   *  the channel list is built, and until then only persisted rows list. */
  channels: () => Channels | undefined;
  listAgents: () => Iterable<string>;
  onChanged: (event: {
    ref: ConversationRef;
    actor: SettingsActor;
    fields: ConversationSettingField[];
    reset: boolean;
  }) => void | Promise<void>;
}

export class ConversationSettingsService implements ConversationSettingsControl {
  private readonly mutex = new KeyedMutex();
  private readonly descriptors = new Map<string, ConversationDescriptor>();

  constructor(private readonly deps: ConversationSettingsServiceDeps) {}

  /** Remember provider-native discovery metadata without changing settings. */
  observe(descriptor: ConversationDescriptor): void {
    this.remember(descriptor);
    if (descriptor.parent) {
      const existing = this.descriptors.get(this.key(descriptor.parent));
      if (!existing) {
        this.remember({
          ref: descriptor.parent,
          service: descriptor.service,
          kind: "channel",
          displayName: descriptor.containerName ?? descriptor.parent.conversationId,
          containerName: descriptor.containerName,
        });
      }
    }
  }

  async list(input: ListConversationSettingsInput = {}): Promise<ConversationSettingsPage> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const offset = cursorOffset(input.cursor);
    // The public cursor addresses the normalized, cross-provider result set.
    // Ask every directory for enough of its sorted prefix to construct that
    // page plus one lookahead item; passing the public cursor to one provider
    // would incorrectly treat a provider-local cursor as a global one.
    const live = await this.discover(input, offset + limit + 1);
    const selectedConnection = input.connectionId
      ? this.deps.connections.all().find((connection) => connection.id === input.connectionId)
      : undefined;
    const known =
      input.connectionId && !selectedConnection
        ? []
        : this.deps.repository.listKnown({
            service: selectedConnection?.service,
            query: input.query,
          });
    const byRef = new Map<
      string,
      { descriptor: ConversationDescriptor; source: "live" | "known" | "configured" }
    >();
    for (const descriptor of live) {
      // Directory discovery is not an address-book enumeration surface. DMs
      // enter this page only after Rome has persisted the conversation.
      if (descriptor.kind === "dm") continue;
      this.remember(descriptor);
      byRef.set(this.key(descriptor.ref), { descriptor, source: "live" });
    }
    for (const row of known) {
      // Native threads inherit from their parent. Persisted DMs are included
      // only after message history exists or an explicit reset override was
      // written; live directory contacts never enter through this path.
      if (row.parentSessionId || row.sourceThreadType === "topic") {
        continue;
      }
      if (
        row.sourceThreadType === "private" &&
        row.channelSettings === null &&
        !this.deps.repository.hasMessageHistory(row.id)
      )
        continue;
      // Removing a Connection hides its persisted conversations from settings.
      // Keep the rows intact so reconnecting the same service can recover them,
      // but do not let one orphaned row abort the cross-provider list.
      if (row.sourceChannel && this.deps.connections.find(row.sourceChannel).length === 0) {
        log.debug("conversation_settings.removed_connection_hidden", {
          service: row.sourceChannel,
          conversationId: row.sourceThreadId,
        });
        continue;
      }
      const descriptor = this.descriptorFromRow(row);
      const key = this.key(descriptor.ref);
      const source =
        row.channelSettings !== null || row.agentName !== null ? "configured" : "known";
      const current = byRef.get(key);
      byRef.set(key, {
        descriptor: current?.descriptor ?? descriptor,
        source: source === "configured" ? "configured" : (current?.source ?? source),
      });
    }

    const query = input.query?.trim().toLocaleLowerCase();
    const candidates: Array<{
      descriptor: ConversationDescriptor;
      availability: ConversationSettingsListItem["availability"];
      source: ConversationSettingsListItem["source"];
    }> = [];
    for (const { descriptor, source } of byRef.values()) {
      // Native threads are runtime conversations, not settings aggregates.
      // Their effective settings are resolved through the parent conversation.
      if (this.isThread(descriptor)) continue;
      if (query) {
        const haystack = [descriptor.service, descriptor.containerName, descriptor.displayName]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        if (!haystack.includes(query)) continue;
      }
      const availability = this.availability(descriptor.ref.connectionId);
      if (input.availability && availability !== input.availability) continue;
      candidates.push({ descriptor, availability, source });
    }
    candidates.sort((a, b) => {
      const left = `${a.descriptor.service}\0${a.descriptor.containerName ?? ""}\0${a.descriptor.displayName}\0${a.descriptor.ref.connectionId}\0${a.descriptor.ref.conversationId}`;
      const right = `${b.descriptor.service}\0${b.descriptor.containerName ?? ""}\0${b.descriptor.displayName}\0${b.descriptor.ref.connectionId}\0${b.descriptor.ref.conversationId}`;
      return left.localeCompare(right);
    });
    const page = candidates.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map(async ({ descriptor, availability, source }) => ({
        snapshot: await this.get(descriptor.ref),
        availability,
        source,
      })),
    );
    return {
      items,
      ...(offset + limit < candidates.length ? { nextCursor: encodeCursor(offset + limit) } : {}),
    };
  }

  async get(ref: ConversationRef): Promise<ConversationSettingsSnapshot> {
    const { descriptor, row } = this.resolveConversation(ref);
    if (this.isThread(descriptor)) {
      if (!descriptor.parent) {
        throw new Error(`Thread conversation "${ref.conversationId}" has no parent settings owner`);
      }
      const parent = await this.get(descriptor.parent);
      const settingsOwner = parent.inheritedFrom ?? parent.conversation.ref;
      const snapshot: ConversationSettingsSnapshot = {
        conversation: descriptor,
        supportedFields: parent.supportedFields,
        effective: structuredClone(parent.effective),
        overrides: {},
        inheritedFrom: settingsOwner,
        ...(parent.updatedAt ? { updatedAt: parent.updatedAt } : {}),
        ...(parent.updatedBy ? { updatedBy: parent.updatedBy } : {}),
      };
      log.debug("conversation_settings.opened", {
        connectionId: ref.connectionId,
        conversationId: ref.conversationId,
        settingsOwnerConversationId: settingsOwner.conversationId,
      });
      return snapshot;
    }
    const stored = row?.channelSettings ?? null;
    const direct = this.directOverrides(row, stored);
    const effective = overlay(defaultConversationSettings(), direct);
    const supportedFields = this.supportedFields(descriptor, row);
    const snapshot: ConversationSettingsSnapshot = {
      conversation: descriptor,
      supportedFields,
      effective,
      overrides: direct,
      ...(stored ? { updatedAt: stored.updatedAt, updatedBy: stored.updatedBy } : {}),
    };
    log.debug("conversation_settings.opened", {
      connectionId: ref.connectionId,
      conversationId: ref.conversationId,
    });
    return snapshot;
  }

  update(input: UpdateConversationSettingsInput): Promise<ConversationSettingsSnapshot> {
    try {
      assertActor(input.actor);
      assertKnownSetShape(input.set);
    } catch (err) {
      this.logRejected(input.ref, err);
      return Promise.reject(err);
    }
    return this.mutex
      .runExclusive(this.storageKey(input.ref), async () => {
        const { descriptor, row } = this.resolveConversation(input.ref);
        this.assertSettingsOwner(descriptor, row);
        const supportedFields = this.supportedFields(descriptor, row);
        const supported = new Set(supportedFields);
        // `get` returns a fresh, already-normalized overrides object.
        const next = (await this.get(input.ref)).overrides;
        const changed = new Set<ConversationSettingField>();

        for (const field of input.clear) {
          if (!supported.has(field)) throw new Error(`Unsupported conversation setting "${field}"`);
          clearField(next, field);
          changed.add(field);
        }
        for (const field of supportedFields) {
          const value = fieldValue(input.set, field);
          if (value === undefined) continue;
          assertValue(field, value);
          if (field === "routing.agentName" && typeof value === "string") {
            const name = value.trim();
            const isMain = isCoreMainAgentId(name);
            if (!isMain && !new Set(this.deps.listAgents()).has(name)) {
              throw new Error(`Agent "${name}" is not loaded`);
            }
            setField(next, field, isMain ? null : name);
          } else {
            setField(next, field, value);
          }
          changed.add(field);
        }
        for (const field of CONVERSATION_SETTING_FIELDS) {
          if (fieldValue(input.set, field) !== undefined && !supported.has(field)) {
            throw new Error(`Unsupported conversation setting "${field}"`);
          }
        }

        const routing = fieldValue(next, "routing.agentName");
        const policy = structuredClone(next);
        // Named routing is canonical only in `agent_name`. Preserve a null
        // marker when the guardian explicitly pins this conversation to main,
        // keeping that intent distinct from an absent provider default.
        if (typeof routing === "string") delete policy.routing;
        const stored: StoredConversationSettings = {
          schemaVersion: 1,
          overrides: policy,
          updatedAt: new Date().toISOString(),
          updatedBy: input.actor,
        };
        this.deps.repository.mutate(descriptor, {
          settings: stored,
          agentName: supported.has("routing.agentName")
            ? typeof routing === "string"
              ? routing
              : null
            : undefined,
        });
        await this.deps.onChanged({
          ref: input.ref,
          actor: input.actor,
          fields: [...changed],
          reset: false,
        });
        log.info("conversation_settings.updated", {
          connectionId: input.ref.connectionId,
          conversationId: input.ref.conversationId,
          fields: [...changed],
          actor: input.actor,
        });
        return this.get(input.ref);
      })
      .catch((err) => {
        this.logRejected(input.ref, err);
        throw err;
      });
  }

  reset(input: ResetConversationSettingsInput): Promise<ConversationSettingsSnapshot> {
    try {
      assertActor(input.actor);
    } catch (err) {
      this.logRejected(input.ref, err);
      return Promise.reject(err);
    }
    return this.mutex
      .runExclusive(this.storageKey(input.ref), async () => {
        const { descriptor, row } = this.resolveConversation(input.ref);
        this.assertSettingsOwner(descriptor, row);
        const fields = [...this.supportedFields(descriptor, row)];
        this.deps.repository.mutate(descriptor, {
          settings: null,
          agentName: fields.includes("routing.agentName") ? null : undefined,
        });
        await this.deps.onChanged({ ref: input.ref, actor: input.actor, fields, reset: true });
        log.info("conversation_settings.reset", {
          connectionId: input.ref.connectionId,
          conversationId: input.ref.conversationId,
          actor: input.actor,
        });
        return this.get(input.ref);
      })
      .catch((err) => {
        this.logRejected(input.ref, err);
        throw err;
      });
  }

  private directOverrides(
    row: StoredConversationRow | null,
    stored: StoredConversationSettings | null,
  ): ConversationSettingsOverrides {
    const overrides = normalizeOverrides(stored?.overrides ?? {});
    if (row?.agentName && row.sourceThreadType !== "private") {
      (overrides.routing ??= {}).agentName = row.agentName;
    }
    return overrides;
  }

  private async discover(
    input: ListConversationSettingsInput,
    discoveryLimit: number,
  ): Promise<ConversationDescriptor[]> {
    const selected = input.connectionId
      ? this.deps.connections.all().find((connection) => connection.id === input.connectionId)
      : undefined;
    if (input.connectionId && !selected) return [];
    const channels = (this.deps.channels() ?? []).filter(
      (channel) => !selected || channel.name === selected.service,
    );
    const conversations: ConversationDescriptor[] = [];
    await Promise.all(
      channels.map(async (channel) => {
        if (!channel.directory) return;
        try {
          conversations.push(
            ...(await channel.directory.listConversations({
              query: input.query,
              limit: discoveryLimit,
              includeTopics: false,
              ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            })),
          );
        } catch (err) {
          log.warn("conversation_settings.directory_failed", {
            channel: channel.name,
            error: err instanceof Error ? err.message : String(err),
          });
          // Persisted rows still render; directory availability is not a data gate.
        }
      }),
    );
    return conversations;
  }

  private descriptorFromRow(row: StoredConversationRow): ConversationDescriptor {
    if (!row.sourceThreadId || !row.sourceChannel) {
      throw new Error(`Channel conversation "${row.id}" has no channel address`);
    }
    const connections = this.deps.connections.find(row.sourceChannel);
    if (connections.length !== 1) {
      throw new Error(
        `Channel conversation "${row.id}" requires exactly one ${row.sourceChannel} connection; found ${connections.length}`,
      );
    }
    const ref = {
      connectionId: connections[0]!.id,
      conversationId: row.sourceThreadId as ConversationId,
    };
    const remembered = this.descriptors.get(this.key(ref));
    const descriptor: ConversationDescriptor = {
      ...remembered,
      ref,
      service: row.sourceChannel,
      kind:
        row.sourceThreadType === "private"
          ? "dm"
          : row.sourceThreadType === "topic"
            ? "topic"
            : row.sourceThreadType === "group"
              ? "group"
              : "channel",
      displayName: row.sourceThreadName ?? remembered?.displayName ?? row.name,
    };
    if (row.parentSessionId) {
      const parent = this.deps.repository
        .listKnown({ service: row.sourceChannel })
        .find((candidate) => candidate.id === row.parentSessionId);
      if (parent?.sourceThreadId) {
        descriptor.parent = {
          connectionId: connections[0]!.id,
          conversationId: parent.sourceThreadId as ConversationId,
        };
      }
    }
    this.remember(descriptor);
    return descriptor;
  }

  private resolveConversation(ref: ConversationRef): {
    descriptor: ConversationDescriptor;
    row: StoredConversationRow | null;
  } {
    const remembered = this.descriptors.get(this.key(ref));
    if (remembered) {
      const row = this.deps.repository.find(remembered.service, ref.conversationId);
      return { descriptor: row ? this.descriptorFromRow(row) : remembered, row };
    }
    const connection = this.deps.connections.get(ref.connectionId);
    const row = this.deps.repository.find(connection.service, ref.conversationId);
    if (row) return { descriptor: this.descriptorFromRow(row), row };
    const descriptor: ConversationDescriptor = {
      ref,
      service: connection.service,
      kind: "channel",
      displayName: ref.conversationId,
    };
    this.remember(descriptor);
    return { descriptor, row: null };
  }

  private remember(descriptor: ConversationDescriptor): void {
    this.descriptors.set(this.key(descriptor.ref), descriptor);
  }

  private supportedFields(
    descriptor: ConversationDescriptor,
    row: StoredConversationRow | null,
  ): readonly ConversationSettingField[] {
    if (descriptor.kind === "dm" || row?.sourceThreadType === "private") {
      return CORE_CONVERSATION_SETTING_FIELDS;
    }
    return (
      CONVERSATION_SETTING_FIELDS_BY_SERVICE.get(descriptor.service) ??
      CORE_CONVERSATION_SETTING_FIELDS
    );
  }

  private availability(connectionId: string): ConversationSettingsListItem["availability"] {
    let connection;
    try {
      connection = this.deps.connections.get(connectionId);
    } catch {
      return "not-connected";
    }
    return connection.isUnlocked("talk") ? "online" : "offline";
  }

  private isThread(descriptor: ConversationDescriptor): boolean {
    return descriptor.kind === "topic" || descriptor.parent !== undefined;
  }

  private assertSettingsOwner(
    descriptor: ConversationDescriptor,
    row: StoredConversationRow | null,
  ): void {
    if (row?.sourceThreadType === "private" || descriptor.kind === "dm") return;
    if (!this.isThread(descriptor)) return;
    if (!descriptor.parent) {
      throw new Error(
        `Thread conversation "${descriptor.ref.conversationId}" has no parent settings owner`,
      );
    }
    throw new Error(
      `Conversation "${descriptor.ref.conversationId}" is a thread and follows parent "${descriptor.parent.conversationId}"; update the parent conversation instead`,
    );
  }

  private key(ref: ConversationRef): string {
    return `${ref.connectionId}\0${ref.conversationId}`;
  }

  private storageKey(ref: ConversationRef): string {
    return `${this.deps.connections.get(ref.connectionId).service}\0${ref.conversationId}`;
  }

  private logRejected(ref: ConversationRef, err: unknown): void {
    log.warn("conversation_settings.rejected", {
      connectionId: ref.connectionId,
      conversationId: ref.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
