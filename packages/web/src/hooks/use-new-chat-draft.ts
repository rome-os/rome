import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type { AgentMention } from "@/lib/chat-types";
import type { SkillSelection } from "@/components/chat/composer/SkillCommandChip";
import { useDashboardIdentity } from "./use-dashboard-identity";
import {
  activeDraftOwner,
  activateDraftOwner,
  consumeDraftIntent,
  DRAFT_RESET_EVENT,
  DRAFT_RESTORED_EVENT,
  emptyNewChatDraft,
  readNewChatDraft,
  restoreNewChatDraft,
  writeNewChatDraft,
  type NewChatDraftData,
} from "@/lib/new-chat-draft-storage";

export interface NewChatSeed {
  intent: string;
  text?: string;
  projectPath?: string;
  agentMention?: AgentMention | null;
  skill?: SkillSelection | null;
}

/** Local React state is authoritative. Storage is read on hydration or a conditional failure restore. */
export function useNewChatDraft(
  enabled: boolean,
  seed?: NewChatSeed,
  initial?: Partial<NewChatDraftData>,
) {
  const { data: identity } = useDashboardIdentity({ enabled });
  const owner =
    identity?.kind === "guardian"
      ? "guardian:" + identity.userId
      : identity?.kind === "visitor"
        ? "visitor:" + identity.accountId
        : null;
  const [value, setValue] = useState(() => ({ ...emptyNewChatDraft(), ...initial }));
  const current = useRef(value);
  const edits = useRef(0);
  const hydrated = useRef<string | null>(null);
  const receipts = useRef(new Set<string>());
  const mounted = useRef(false);
  const live = useRef({ enabled, owner });
  live.current = { enabled, owner };
  const replace = useCallback((next: NewChatDraftData) => {
    current.current = next;
    if (mounted.current) setValue(next);
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (!enabled || !owner || hydrated.current === owner) return;
    const switching = hydrated.current !== null;
    activateDraftOwner(owner);
    const stored = readNewChatDraft(owner);
    if (switching || edits.current === 0) replace(stored?.value ?? emptyNewChatDraft());
    hydrated.current = owner;
    // An edit made before identity loaded wins over a later hydration.
    if (!stored || (!switching && edits.current > 0)) writeNewChatDraft(owner, current.current);
  }, [enabled, owner, replace]);

  const change = useCallback(
    <K extends keyof NewChatDraftData>(field: K, action: SetStateAction<NewChatDraftData[K]>) => {
      const previous = current.current;
      const nextField =
        typeof action === "function"
          ? (action as (old: NewChatDraftData[K]) => NewChatDraftData[K])(previous[field])
          : action;
      if (Object.is(previous[field], nextField)) return;
      const manual =
        field !== "text" && field !== "manual"
          ? [...new Set([...previous.manual, field as NewChatDraftData["manual"][number]])]
          : previous.manual;
      const next = { ...previous, [field]: nextField, manual };
      edits.current++;
      replace(next);
      const { enabled, owner } = live.current;
      if (enabled && owner && hydrated.current === owner) writeNewChatDraft(owner, next);
    },
    [replace],
  );

  useLayoutEffect(() => {
    if (
      !enabled ||
      !owner ||
      !seed ||
      Object.keys(seed).length === 1 ||
      receipts.current.has(seed.intent)
    )
      return;
    receipts.current.add(seed.intent);
    if (!consumeDraftIntent(seed.intent)) return;
    const next = { ...current.current };
    if (!next.text.length) {
      if (seed.text !== undefined) next.text = seed.text;
      if (seed.skill !== undefined && !next.manual.includes("skill")) next.skill = seed.skill;
    }
    if (seed.projectPath !== undefined && !next.manual.includes("projectPath"))
      next.projectPath = seed.projectPath;
    if (seed.agentMention !== undefined && !next.manual.includes("agentMention"))
      next.agentMention = seed.agentMention;
    replace(next);
    writeNewChatDraft(owner, next);
  }, [
    enabled,
    owner,
    seed?.intent,
    seed?.text,
    seed?.skill,
    seed?.projectPath,
    seed?.agentMention,
    replace,
  ]);

  useLayoutEffect(() => {
    const reset = () => {
      hydrated.current = null;
      edits.current++;
      replace(emptyNewChatDraft());
    };
    const restored = (event: Event) => {
      if (!live.current.enabled || (event as CustomEvent).detail !== live.current.owner) return;
      const stored = readNewChatDraft(live.current.owner!);
      if (stored) replace(stored.value);
    };
    window.addEventListener(DRAFT_RESET_EVENT, reset);
    window.addEventListener(DRAFT_RESTORED_EVENT, restored);
    return () => {
      window.removeEventListener(DRAFT_RESET_EVENT, reset);
      window.removeEventListener(DRAFT_RESTORED_EVENT, restored);
    };
  }, [replace]);

  const beginSend = useCallback(
    (optimistic: boolean) => {
      const snapshot = current.current;
      const revision = edits.current;
      const { enabled, owner } = live.current;
      const cleared = enabled && owner ? writeNewChatDraft(owner, emptyNewChatDraft()) : null;
      if (optimistic) replace({ ...snapshot, text: "", skill: null });
      const unchanged = () =>
        edits.current === revision &&
        (!enabled || live.current.owner === owner) &&
        (!cleared || !owner || activeDraftOwner() === owner);
      return {
        accept() {
          if (!optimistic && unchanged()) replace({ ...current.current, text: "", skill: null });
        },
        fail() {
          // After early session adoption local edits no longer save to New chat;
          // they must still defeat this older recovery snapshot.
          if (edits.current !== revision || (enabled && live.current.owner !== owner)) return false;
          const restored =
            owner && cleared ? restoreNewChatDraft(owner, cleared.revision, snapshot) : false;
          if (unchanged()) replace(snapshot);
          return unchanged() && (restored || !enabled || !cleared);
        },
      };
    },
    [replace],
  );

  return {
    value,
    change,
    beginSend,
    current,
    ready: !enabled || (owner !== null && hydrated.current === owner),
  };
}
