import {
  mainAgentDisplayName,
  prettyAgentName,
  type ChatMessageSender,
} from "@rome/api-types/chat";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { guardianAuth } from "../../db/schema.js";
import { VisitorProfilesRepository } from "../../access/visitor-profiles.js";
import type { SessionActor } from "../../access/session-actor.js";
import type { ApiDeps } from "../deps.js";
import { appIdToPathSegment } from "../../apps/packaging/app-id.js";
import {
  automatedSource,
  speaksForGuardian,
  promptSafeSourceName,
} from "../../webchat/automated-source.js";

/**
 * Resolve each message's source or actor into the sender the dashboard shows. The
 * name and picture are read now, not when the message was sent, so a new
 * picture shows on old messages too.
 */
export async function resolveChatSenders(
  deps: Pick<ApiDeps, "db" | "settingsRepo" | "agentLoader" | "appCatalog">,
  actors: ReadonlyMap<string, SessionActor>,
  sources: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, ChatMessageSender>> {
  const senders = new Map<string, ChatMessageSender>();
  if (actors.size === 0 && sources.size === 0) return senders;

  const list = [...actors.values()];
  const visitorIds = [
    ...new Set(list.flatMap((actor) => (actor.kind === "visitor" ? [actor.accountId] : []))),
  ];
  const profiles = await new VisitorProfilesRepository(deps.db).getMany(visitorIds);

  let guardian: Extract<ChatMessageSender, { kind: "guardian" }> | null = null;
  if (list.some((actor) => actor.kind === "guardian")) {
    const name = await deps.settingsRepo.get("guardianName");
    const [seat] = await deps.db
      .select({ email: guardianAuth.email, avatarUrl: guardianAuth.avatarUrl })
      .from(guardianAuth)
      .limit(1);
    guardian = {
      kind: "guardian",
      name: typeof name === "string" && name ? name : (seat?.email ?? null),
      avatarUrl: seat?.avatarUrl ?? null,
    };
  }

  for (const [messageId, actor] of actors) {
    if (actor.kind === "guardian" && guardian) {
      senders.set(messageId, guardian);
    } else if (actor.kind === "visitor") {
      const profile = profiles.get(actor.accountId);
      senders.set(messageId, {
        kind: "visitor",
        accountId: actor.accountId,
        name: profile?.email ?? actor.email,
        avatarUrl: profile?.avatarUrl ?? null,
      });
    }
  }
  for (const [messageId, senderId] of sources) {
    const sender = await resolveAutomatedSender(deps, senderId);
    if (sender) {
      const source = automatedSource(senderId)!;
      const actor = actors.get(messageId);
      if (
        guardian &&
        actor?.kind === "guardian" &&
        (source.onBehalf ?? speaksForGuardian(source, actor.kind))
      ) {
        sender.onBehalfOf = guardian;
      }
      senders.set(messageId, sender);
    }
  }
  return senders;
}

export async function resolveAutomatedSender(
  deps: Pick<ApiDeps, "agentLoader" | "appCatalog" | "settingsRepo">,
  senderId: string,
): Promise<Extract<ChatMessageSender, { kind: "automated" }> | null> {
  const source = automatedSource(senderId);
  if (!source) return null;
  let name = source.id;
  let appId: string | undefined;
  if (source.type === "agent" && source.id) {
    const agent = deps.agentLoader.list().find((candidate) => candidate.name === source.id);
    name = isCoreMainAgentId(source.id)
      ? mainAgentDisplayName(await deps.settingsRepo.get("agentName"))
      : agent
        ? prettyAgentName(source.id)
        : source.id;
    appId = agent?.ownerId;
  } else if (source.type === "app" && source.id) {
    appId = source.id;
    name = deps.appCatalog.get(source.id)?.displayName ?? source.id;
  }
  const app = appId ? deps.appCatalog.get(appId) : undefined;
  return {
    kind: "automated",
    sourceType: source.type,
    name,
    iconUrl: appId && app?.iconAbsolutePath ? `/api/apps/${appIdToPathSegment(appId)}/icon` : null,
  };
}

export function automatedMessageNotice(
  sender: Extract<ChatMessageSender, { kind: "automated" }>,
): string {
  const name = sender.name ? promptSafeSourceName(sender.name) : "";
  const from = name ? ` from ${sender.sourceType ?? "automation"} ${JSON.stringify(name)}` : "";
  return `[Automated message${from}. The guardian did not type this.]`;
}
