import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Lock, Paperclip, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { ProjectSelector } from "@/components/project-selector";
import { SourceConnect } from "@/components/sync/SourceConnect";
import { cn } from "@/lib/utils";
import { extractFilesFromClipboard } from "@/lib/clipboard-files";
import { ChatApiError, createProject as apiCreateProject, saveSetting } from "@/lib/chat-api";
import { useInvalidateSettings, useSettings } from "@/hooks/use-settings";
import { usePeople } from "@/hooks/use-people";
import { useChatLocations } from "@/hooks/use-chat-locations";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import {
  DEFAULT_LARGE_MODEL_SELECTION,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REASONING_EFFORT,
  LARGE_MODEL_OPTIONS,
} from "@/lib/chat-constants";
import { getProjectDisplayName, isReasoningEffort } from "@/lib/chat-helpers";
import { shouldSubmitOnEnter } from "@/lib/keyboard-submit";
import type {
  AgentMention,
  PendingUpload,
  ProjectOption,
  ReasoningEffort,
  ChatErrorNotice,
} from "@/lib/chat-types";
import { ErrorEventView } from "./entries/ErrorEventView";
import { AgentMentionChip } from "./composer/AgentMentionChip";
import { AgentMentionMenu, type AgentMentionMenuHandle } from "./composer/AgentMentionMenu";
import { ImpersonationMenu } from "./composer/ImpersonationMenu";
import { ModelSelectorMenu } from "./composer/ModelSelectorMenu";
import { PendingUploadsList } from "./composer/PendingUploadsList";
import { ReasoningEffortMenu } from "./composer/ReasoningEffortMenu";
import { SkillCommandChip, type SkillSelection } from "./composer/SkillCommandChip";
import { SlashSkillMenu, type SlashSkillMenuHandle } from "./composer/SlashSkillMenu";
import { WorkspaceContextChips } from "./composer/WorkspaceContextChips";
import {
  COMPOSER_HINT_KEYS,
  composerHints,
  pickComposerHint,
  type ComposerHint,
} from "./composer/composer-hints";
import { useHorizontalScrollRail } from "./HorizontalScrollRail";
import {
  clearNewChatDraft,
  currentAuthEpoch,
  loadNewChatDraft,
  saveNewChatDraft,
} from "@/lib/new-chat-draft-storage";
import { randomUUID } from "@/lib/random-uuid";
import { chatSearchShortcutForPlatform } from "@/lib/chat-search-shortcut";
import type { DraftDeviceFolder } from "@/lib/device-folder";

export interface ChatComposerSnapshot {
  text: string;
  uploads: PendingUpload[];
  personaId?: string;
  largeModelSelection?: string;
  reasoningEffort: ReasoningEffort;
  projectPath: string;
  // Set only in draft mode, and only when no project is: the two exclude each other.
  deviceFolder?: DraftDeviceFolder;
  // Set only in draft mode when the user picked an `@app/agent` from the
  // mention menu. Active sessions inherit their agent from `pinnedAgentMention`
  // instead — `onSend` for those should ignore this field.
  agentMention?: AgentMention;
  // The structured skill selection (the `/` chip) is sent as the
  // turn's `skillName` field; `text` carries only the task.
  skillName?: string;
  // Sent as the turn's `inputId`, which the server records once per session.
  // Resending an unchanged draft after a failure reuses it, so a turn the server
  // accepted before the failure is returned rather than recorded twice.
  inputId?: string;
}

export interface ChatComposerSendControls {
  /** Called as soon as a new session exists, even if posting its first turn fails. */
  onSessionCreated?: () => void;
  /** `null` means the browser cannot determine the multipart body size. */
  onUploadProgress: (progress: number | null) => void;
  /**
   * Aborted when the user cancels an attachment upload. Hosts must forward it
   * to `postSessionTurn` so the request actually stops, rather than leaving it
   * to run while the composer pretends it was cancelled.
   */
  signal: AbortSignal;
}

export interface ChatComposerHandle {
  focus: () => void;
  insertText: (text: string, options?: { focus?: boolean }) => void;
  setSkillSelection: (skill: SkillSelection | null) => void;
  addFiles: (files: File[]) => void;
  /**
   * Send a turn immediately with the given text, bypassing the textarea state.
   * Used by "start"-mode quick entries: it synthesizes a snapshot from the
   * provided text plus the composer's *current* selections (model / persona /
   * project / reasoning / skill) so a programmatic send is as faithful as a
   * user-typed one. No-op while the composer is busy or the turn is empty.
   */
  submit: (text: string, opts?: { skillName?: string }) => void;
  /**
   * Read the per-turn metadata (persona / reasoning) the composer would
   * currently send. Used by non-composer submit paths (e.g. inline app
   * component results) to align with what onSend would emit, so server doesn't
   * silently fall back to guardian persona or stored reasoning effort.
   */
  getMetadataSnapshot: () => {
    personaId?: string;
    reasoningEffort: ReasoningEffort;
  };
}

export interface ChatComposerProps {
  persistNewChatDraft?: boolean;
  // Whether the project picker is shown (typically only in draft mode).
  showProjectSelector?: boolean;
  // Whether the large-model picker is shown.
  showModelSelector?: boolean;
  // An open chat's own model pick. When set, the picker shows and changes it,
  // and sends carry no selection: the chat stores it. A draft leaves it unset,
  // so the picker edits the default for new chats.
  chatModelSelection?: { value: string; onChange: (next: string) => void };
  // Seed for the draft project name. Honored once at mount and again when it
  // changes from undefined → defined (i.e., transitioning into a new draft).
  initialProjectName?: string;
  // Seed for the draft device folder, e.g. "New chat in this folder" in the
  // sidebar. Same timing as initialProjectName, and it wins over both the
  // project and a saved draft.
  initialDeviceFolder?: DraftDeviceFolder;
  // Pinned agent for an active session — once set, the chip is non-removable
  // and the `@` menu is suppressed (session is locked to this agent).
  pinnedAgentMention?: AgentMention | null;
  // Optional seed for draft mode. When provided (and the composer is not
  // locked) it pre-selects the agent chip so callers navigating into the
  // draft composer can pre-target a specific agent (e.g. the "chat with
  // agent" affordance on the apps page).
  initialAgentMention?: AgentMention | null;
  // Lock agent selection without showing a chip. Used by active sessions that
  // defaulted to `main` (no `pinnedAgentMention`) — the agent is still fixed
  // for the session's lifetime, so the `@` menu must stay suppressed.
  lockAgentMention?: boolean;
  // Streaming-aware affordances. When `isStreaming` is true and `onStop` is
  // provided, a Stop button shows next to Send.
  isStreaming?: boolean;
  onStop?: () => void;
  // Error banner above the input.
  streamError?: string | ChatErrorNotice | null;
  // When a suspendable action has handed off to a sub-agent, the composer shows
  // a banner naming who the guardian is now collaborating with. Turns route to
  // that sub-agent server-side. When that sub-agent has a pending submission
  // awaiting the guardian, `onApprove` is set and the banner gains an Approve
  // button — the approval gate lives here, at the bottom of the surface, rather
  // than as a widget interrupting the conversation flow. Replying instead asks
  // the sub-agent for changes; abandoning is the "Cancel design" header control.
  designingInteraction?: {
    agentLabel: string;
    onApprove?: () => void;
    onCancel?: () => void;
  } | null;
  // Why typing is off right now: a card in the transcript is the only way to
  // answer. While set, a locked strip with this text stands where the box
  // was, so the state reads at a glance. Null or undefined keeps the composer
  // open. The box stays mounted but hidden, so its draft and measurements
  // survive the lock.
  lockedReason?: string | null;
  // Styling for the input box itself (border, surface, padding, blur). The
  // composer owns the box so the pre-send chip row can sit *outside* it; each
  // mount passes its own box look (the floating composer adds backdrop-blur).
  boxClassName?: string;
  // A box for plain text only, for a chat whose other end is not one of Rome's
  // agents (an assistant's chat): no attachments, reasoning effort,
  // impersonation, workspace chips or `/` skills, none of which reach it.
  textOnly?: boolean;
  // Replaces the default placeholder.
  placeholder?: string;
  // Called when the user submits. The composer clears text immediately but
  // keeps uploading attachments visible until this promise settles. If it
  // rejects, the submitted inputs remain available for a retry.
  onSend: (
    snapshot: ChatComposerSnapshot,
    controls: ChatComposerSendControls,
  ) => void | Promise<void>;
}

// The empty input is one line box tall, expressed as `1lh` so it resolves
// against whatever `text-composer` currently is rather than restating the role's
// px here. The textarea carries no vertical padding, so that leaves the box's
// own `p-4` as the only inset above the text and the empty composer reads
// symmetric top to bottom. `min-height` outranks the height the resize below
// writes, which is why the floor lives in CSS and the resize only caps.
//
// It is a backstop rather than the only thing holding that height: `rows={1}`
// gives the element a one-line content box, so the `scrollHeight` the resize
// measures never reads below one line either. An engine too old for the `lh`
// unit drops the declaration and still lands on the same height.
const TEXTAREA_MIN_HEIGHT = "1lh";
const TEXTAREA_MAX_HEIGHT = 240;

function clampTextareaHeight(el: HTMLTextAreaElement, maxHeight: number) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  {
    persistNewChatDraft = false,
    showProjectSelector = false,
    showModelSelector = false,
    chatModelSelection,
    initialProjectName,
    initialDeviceFolder,
    pinnedAgentMention = null,
    initialAgentMention = null,
    lockAgentMention = false,
    isStreaming = false,
    onStop,
    streamError,
    designingInteraction = null,
    lockedReason = null,
    boxClassName,
    textOnly = false,
    placeholder,
    onSend,
  },
  ref,
) {
  const { t } = useTranslation("chat");

  const [{ storedDraft, authEpoch }] = useState(() => {
    const authEpoch = persistNewChatDraft ? currentAuthEpoch() : null;
    return { authEpoch, storedDraft: persistNewChatDraft ? loadNewChatDraft() : null };
  });
  const [inputText, setInputText] = useState(() => storedDraft?.text ?? "");
  const sessionCreatedRef = useRef(false);
  // The send-time clear must not re-save the unchanged context in its effect.
  const skipNextDraftSaveRef = useRef(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [uploadInFlight, setUploadInFlight] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // When `pinnedAgentMention` is set, the session is already bound to an
  // agent — the `@` menu and the local draftAgentMention are inert.
  const [draftAgentMention, setDraftAgentMention] = useState<AgentMention | null>(
    () => initialAgentMention ?? storedDraft?.agentMention ?? null,
  );
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  // Index of the `@` that opened the menu. Used to splice the query out of
  // the textarea once the user picks an item.
  const [mentionAnchorIndex, setMentionAnchorIndex] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  // Reset draft mention whenever the host transitions us into a pinned or
  // locked session — the session's bound agent wins. `lockAgentMention` covers
  // the default-to-main case where no chip is shown but the agent is still
  // fixed for the session.
  const agentMentionLocked = pinnedAgentMention !== null || lockAgentMention;
  useEffect(() => {
    if (agentMentionLocked) {
      setDraftAgentMention(null);
      setMentionMenuOpen(false);
      setMentionAnchorIndex(null);
      setMentionQuery("");
    }
  }, [agentMentionLocked]);
  const effectiveMention = pinnedAgentMention ?? draftAgentMention;
  const coarsePointer = useCoarsePointer();

  // The empty box shows one hint, picked again on each send rather than on a
  // timer. The set of hints changes when a draft becomes a chat or the pointer
  // changes; the shown one stays while it still applies.
  const hints = useMemo(
    () =>
      composerHints({
        draft: !agentMentionLocked,
        textOnly,
        projectSelector: showProjectSelector,
        coarsePointer,
      }),
    [agentMentionLocked, textOnly, showProjectSelector, coarsePointer],
  );
  const [hint, setHint] = useState<ComposerHint>(() => pickComposerHint(hints, null));
  useEffect(() => {
    setHint((current) => (hints.includes(current) ? current : pickComposerHint(hints, current)));
  }, [hints]);

  // Open while the message starts with `/` and the cursor is still inside the
  // first token. Selecting pins the skill as a structured chip (mirroring the
  // `@` mention) — the turn carries it as a `skillName` field, so no
  // name-shape constraint applies. Expansion stays server-side.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [draftSkill, setDraftSkill] = useState<SkillSelection | null>(
    () => storedDraft?.skill ?? null,
  );

  const { data: settings } = useSettings();
  const { data: peopleData } = usePeople();
  const invalidateSettings = useInvalidateSettings();
  const people = peopleData ?? [];
  const modelSelectorEnabled = settings?.enableModelSelector === true;
  const impersonationEnabled = settings?.enableImpersonation === true;
  const toolbarRail = useHorizontalScrollRail(
    `${showProjectSelector}:${impersonationEnabled}:${showModelSelector && modelSelectorEnabled}`,
  );
  const guardianName = (settings?.guardianName as string | undefined) ?? "";
  // Persisted preferences are seeded from settings on first load, then owned
  // locally so the picker reflects the user's in-session choice immediately
  // (the save round-trip + invalidation lands afterwards).
  const [largeModelSelection, setLargeModelSelection] = useState(DEFAULT_LARGE_MODEL_SELECTION);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const seededFromSettingsRef = useRef(false);
  useEffect(() => {
    if (!settings || seededFromSettingsRef.current) return;
    const stored = settings.webchatLargeModel;
    if (typeof stored === "string" && LARGE_MODEL_OPTIONS.some((option) => option.id === stored)) {
      setLargeModelSelection(stored);
    }
    if (isReasoningEffort(settings.webchatReasoningEffort)) {
      setReasoningEffort(settings.webchatReasoningEffort);
    }
    seededFromSettingsRef.current = true;
  }, [settings]);
  const [selectedPersonId, setSelectedPersonId] = useState<string>(
    () => storedDraft?.personaId ?? "",
  );

  const personaId =
    selectedPersonId && (impersonationEnabled || !settings) ? selectedPersonId : undefined;

  const [impersonationMenuOpen, setImpersonationMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);

  const [draftProjectName, setDraftProjectName] = useState(() =>
    initialDeviceFolder
      ? DEFAULT_PROJECT_NAME
      : initialProjectName?.trim() || storedDraft?.projectPath || DEFAULT_PROJECT_NAME,
  );
  // A project and a device folder exclude each other: a project the composer
  // opens with wins over a folder left in the saved draft.
  const [draftDeviceFolder, setDraftDeviceFolder] = useState<DraftDeviceFolder | null>(
    () =>
      initialDeviceFolder ??
      (initialProjectName?.trim() ? null : (storedDraft?.deviceFolder ?? null)),
  );
  const locations = useChatLocations(showProjectSelector);
  const projectCatalog = locations.query.data?.projects ?? null;
  // Errors from creating a project; a failed load shows from the query below.
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const locationsError = locations.query.error;
  const loadError =
    locationsError && !locations.query.data
      ? locationsError instanceof ChatApiError && locationsError.message
        ? locationsError.message
        : t("project.errors.loadFailed")
      : null;
  // Errors that need a composer-level banner even when the project picker
  // isn't rendered (e.g. /api/settings save failures in an embed that opts
  // out of `showProjectSelector`).
  const [composerError, setComposerError] = useState<string | null>(null);
  const [draftProjectMenuOpen, setDraftProjectMenuOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [createProjectFormOpen, setCreateProjectFormOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  // When the optional source link is set, a
  // freshly-created project opens the connect wizard in link mode.
  const [connectOnCreate, setConnectOnCreate] = useState(false);
  const [pendingConnectPath, setPendingConnectPath] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentTrayRef = useRef<HTMLDivElement>(null);
  const [textareaMaxHeight, setTextareaMaxHeight] = useState(TEXTAREA_MAX_HEIGHT);

  useLayoutEffect(() => {
    const tray = attachmentTrayRef.current;
    if (!tray) return;
    // Attachments share the text area's height budget so previews cannot push
    // the toolbar below the viewport when the draft already fills the input.
    const measure = () => {
      setTextareaMaxHeight(Math.max(0, TEXTAREA_MAX_HEIGHT - tray.getBoundingClientRect().height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tray);
    return () => observer.disconnect();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  // State drives the UI, while the ref closes the same-event gap before React
  // commits that state (for example, two rapid Enter keydown events).
  const uploadInFlightRef = useRef(false);
  // Live for exactly one upload; `cancelUpload` aborts through it.
  const uploadAbortRef = useRef<AbortController | null>(null);
  // The last failed send, kept until a send succeeds.
  const failedSendRef = useRef<{
    inputId: string;
    text: string;
    uploads: PendingUpload[];
    skill: SkillSelection | null;
  } | null>(null);

  // Resize the textarea to fit its content. The `onInput` handler below also
  // runs this math, but only on user typing — programmatic clears (e.g. the
  // optimistic reset in `runSend` after a send) don't fire `input`, so the
  // box would otherwise stay at its previous (potentially maxed-out) height
  // and not shrink back to a single line. We mirror the onInput math here
  // and let React re-apply it after every value change.
  // A hidden box measures zero, so a locked composer waits and resizes again
  // once the lock lifts.
  const locked = lockedReason !== null && lockedReason !== undefined;
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || locked) return;
    clampTextareaHeight(el, textareaMaxHeight);
  }, [inputText, textareaMaxHeight, locked]);

  // The composer's menus render outside the box, so hiding it leaves an open
  // one on screen. Close them as the lock engages.
  useEffect(() => {
    if (!locked) return;
    setMentionMenuOpen(false);
    setSlashMenuOpen(false);
    setImpersonationMenuOpen(false);
    setModelMenuOpen(false);
    setReasoningMenuOpen(false);
    setDraftProjectMenuOpen(false);
  }, [locked]);

  // Whether the textarea held focus when the current Send press began.
  const textareaFocusedAtPressRef = useRef(false);

  useEffect(() => {
    if (!initialProjectName) return;
    setDraftProjectName(initialProjectName.trim());
    setDraftDeviceFolder(null);
  }, [initialProjectName]);
  useEffect(() => {
    if (!initialDeviceFolder) return;
    setDraftDeviceFolder(initialDeviceFolder);
    setDraftProjectName(DEFAULT_PROJECT_NAME);
  }, [initialDeviceFolder]);
  useEffect(() => {
    if (initialAgentMention && !agentMentionLocked) setDraftAgentMention(initialAgentMention);
  }, [initialAgentMention, agentMentionLocked]);

  useEffect(() => {
    if (!persistNewChatDraft || sessionCreatedRef.current) return;
    if (skipNextDraftSaveRef.current) {
      skipNextDraftSaveRef.current = false;
      return;
    }
    saveNewChatDraft(
      {
        version: 1,
        text: inputText,
        projectPath: draftProjectName,
        agentMention: draftAgentMention,
        skill: draftSkill,
        personaId: selectedPersonId,
        ...(draftDeviceFolder ? { deviceFolder: draftDeviceFolder } : {}),
      },
      authEpoch,
    );
  }, [
    persistNewChatDraft,
    authEpoch,
    inputText,
    draftProjectName,
    draftDeviceFolder,
    draftAgentMention,
    draftSkill,
    selectedPersonId,
  ]);

  useLayoutEffect(() => {
    if (!persistNewChatDraft) return;
    const el = textareaRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // If impersonation gets disabled mid-session, drop any selection so the
  // composer doesn't carry a hidden persona id.
  useEffect(() => {
    if (!settings || impersonationEnabled) return;
    setSelectedPersonId("");
    setImpersonationMenuOpen(false);
  }, [settings, impersonationEnabled]);

  // Only a draft's first send carries the pick; an open chat has stored it.
  const draftModelSelection =
    showModelSelector && modelSelectorEnabled && !chatModelSelection
      ? largeModelSelection
      : undefined;

  const updateLargeModelSelection = useCallback(
    async (next: string) => {
      if (uploadInFlightRef.current) return;
      setLargeModelSelection(next);
      setComposerError(null);
      const ok = await saveSetting("webchatLargeModel", next).catch(() => false);
      if (!ok) {
        setComposerError(t("modelSelector.saveFailed"));
      }
      invalidateSettings();
    },
    [t, invalidateSettings],
  );

  const updateReasoningEffort = useCallback(
    async (next: ReasoningEffort) => {
      if (uploadInFlightRef.current) return;
      setReasoningEffort(next);
      setComposerError(null);
      const ok = await saveSetting("webchatReasoningEffort", next).catch(() => false);
      if (!ok) {
        setComposerError(t("reasoningEffort.saveFailed"));
      }
      invalidateSettings();
    },
    [t, invalidateSettings],
  );

  const createProjectAndSelect = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) {
      setProjectsError(t("project.errors.nameRequired"));
      return;
    }
    setCreatingProject(true);
    setProjectsError(null);
    try {
      const data: ProjectOption = await apiCreateProject(name);
      locations.addProject(data);
      setNewProjectName("");
      setCreateProjectFormOpen(false);
      setProjectSearchQuery("");
      setDraftProjectName(data.name);
      setDraftDeviceFolder(null);
      setDraftProjectMenuOpen(false);
      if (connectOnCreate) {
        setPendingConnectPath(data.name);
        setConnectOnCreate(false);
      }
    } catch (error) {
      const fallback = t("project.errors.createFailed");
      setProjectsError(error instanceof ChatApiError && error.message ? error.message : fallback);
    } finally {
      setCreatingProject(false);
    }
  }, [newProjectName, t, connectOnCreate, locations.addProject]);

  const addPendingFiles = useCallback((files: File[]) => {
    // The visible file picker is disabled during an upload, but paste and the
    // parent drop zones enter through this callback directly. Guard the shared
    // boundary so a file cannot be added to the tray without belonging to the
    // multipart request whose progress it displays.
    if (files.length === 0 || uploadInFlightRef.current) return;
    setPendingUploads((prev) => [...prev, ...files.map((file) => ({ id: randomUUID(), file }))]);
  }, []);

  const invokeOnSend = useCallback(
    async (snapshot: ChatComposerSnapshot, clearDraftOnAdoption = false) => {
      const tracksUpload = snapshot.uploads.length > 0;
      const controller = new AbortController();
      if (tracksUpload) {
        uploadInFlightRef.current = true;
        uploadAbortRef.current = controller;
        setUploadInFlight(true);
        setUploadProgress(0);
      }
      try {
        await onSend(snapshot, {
          onUploadProgress: (progress) => {
            if (!tracksUpload) return;
            setUploadProgress(progress === null ? null : Math.max(0, Math.min(1, progress)));
          },
          signal: controller.signal,
          onSessionCreated: () => {
            sessionCreatedRef.current = true;
            if (clearDraftOnAdoption && textareaRef.current) clearNewChatDraft();
          },
        });
      } finally {
        if (tracksUpload) {
          uploadInFlightRef.current = false;
          uploadAbortRef.current = null;
          setUploadInFlight(false);
          setUploadProgress(null);
        }
      }
    },
    [onSend],
  );

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      insertText: (text: string, options?: { focus?: boolean }) => {
        if (uploadInFlightRef.current) return;
        setInputText(text);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          clampTextareaHeight(el, textareaMaxHeight);
          if (options?.focus !== false) el.focus();
          el.setSelectionRange(text.length, text.length);
        });
      },
      setSkillSelection: (skill: SkillSelection | null) => {
        if (uploadInFlightRef.current) return;
        setDraftSkill(skill);
        setSlashMenuOpen(false);
        setSlashQuery("");
      },
      addFiles: addPendingFiles,
      submit: (text: string, opts?: { skillName?: string }) => {
        if (uploadInFlightRef.current) return;
        const trimmed = text.trim();
        const skillName = opts?.skillName ?? draftSkill?.name;
        if (!trimmed && pendingUploads.length === 0 && !skillName) return;
        const snapshot: ChatComposerSnapshot = {
          text: trimmed,
          uploads: pendingUploads,
          personaId,
          largeModelSelection: draftModelSelection,
          reasoningEffort,
          projectPath: draftProjectName,
          deviceFolder: draftDeviceFolder ?? undefined,
          agentMention: draftAgentMention ?? undefined,
          skillName,
        };
        void invokeOnSend(snapshot)
          .then(() => {
            const sentIds = new Set(snapshot.uploads.map((upload) => upload.id));
            setPendingUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
          })
          .catch(() => {
            // The imperative submit path leaves its inputs in place, so the
            // parent error banner is sufficient and the turn remains retryable.
          });
      },
      getMetadataSnapshot: () => ({
        personaId,
        reasoningEffort,
      }),
    }),
    [
      addPendingFiles,
      textareaMaxHeight,
      personaId,
      reasoningEffort,
      draftSkill,
      pendingUploads,
      draftModelSelection,
      draftProjectName,
      draftDeviceFolder,
      draftAgentMention,
      onSend,
      invokeOnSend,
    ],
  );

  const removePendingUpload = useCallback((id: string) => {
    if (uploadInFlightRef.current) return;
    setPendingUploads((prev) => prev.filter((upload) => upload.id !== id));
  }, []);

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    addPendingFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = textOnly ? [] : extractFilesFromClipboard(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        addPendingFiles(files);
      }
    },
    [addPendingFiles, textOnly],
  );

  const runSend = useCallback(async () => {
    if (locked || uploadInFlight || uploadInFlightRef.current) return;
    // A skill chip alone is a sendable turn — the server-expanded prompt asks
    // the agent to read the skill and ask what to do with it.
    if (!inputText.trim() && pendingUploads.length === 0 && !draftSkill) return;

    const text = inputText.trim();
    // The textarea holds the untrimmed value; compare against that when
    // deciding whether the user edited the box during an upload.
    const rawText = inputText;
    const uploads = pendingUploads;
    const skill = draftSkill;
    const failed = failedSendRef.current;
    const inputId =
      failed && failed.text === text && failed.uploads === uploads && failed.skill === skill
        ? failed.inputId
        : randomUUID();
    const snapshot: ChatComposerSnapshot = {
      text,
      uploads,
      personaId,
      largeModelSelection: draftModelSelection,
      reasoningEffort,
      projectPath: draftProjectName,
      deviceFolder: draftDeviceFolder ?? undefined,
      // Pinned sessions ignore this; draft hosts read it to lock the new
      // session to the picked agent.
      agentMention: draftAgentMention ?? undefined,
      skillName: skill?.name,
      inputId,
    };

    // A text-only turn clears optimistically — it is accepted or rejected in
    // one round trip, so the input wipes immediately and is restored on
    // failure. A turn carrying attachments keeps its text on screen for the
    // whole upload instead: the request is long enough to cancel, and wiping
    // text the user may still be reading (or about to cancel) reads as loss.
    // It clears only once the server has accepted the turn.
    const clearsOptimistically = uploads.length === 0;
    if (persistNewChatDraft) {
      clearNewChatDraft();
      skipNextDraftSaveRef.current = clearsOptimistically && (inputText !== "" || skill !== null);
    }
    if (clearsOptimistically) {
      setInputText("");
      setPendingUploads([]);
      setDraftSkill(null);
    }
    setHint((current) => pickComposerHint(hints, current));
    try {
      await invokeOnSend(snapshot, persistNewChatDraft);
      failedSendRef.current = null;
      if (!clearsOptimistically) {
        const sentIds = new Set(uploads.map((upload) => upload.id));
        setPendingUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
        setDraftSkill((current) => (current === skill ? null : current));
        // Anything typed during the upload is newer than what was sent, so it
        // survives; only the exact text that went out is cleared.
        setInputText((current) => (current === rawText ? "" : current));
      }
    } catch {
      failedSendRef.current = { inputId, text, uploads, skill };
      if (
        persistNewChatDraft &&
        (!textareaRef.current || (clearsOptimistically && textareaRef.current.value))
      )
        return;
      // A failed turn in an adopted session belongs there, not in New chat.
      if (persistNewChatDraft && !sessionCreatedRef.current) {
        saveNewChatDraft(
          {
            version: 1,
            text: rawText,
            projectPath: draftProjectName,
            agentMention: draftAgentMention,
            skill,
            personaId: selectedPersonId,
            ...(draftDeviceFolder ? { deviceFolder: draftDeviceFolder } : {}),
          },
          authEpoch,
        );
      }
      if (clearsOptimistically) {
        setInputText(persistNewChatDraft ? rawText : text);
        setPendingUploads(uploads);
        setDraftSkill(skill);
      }
      // Nothing to restore otherwise — a cancelled or failed upload never
      // cleared the text or the attachment tray in the first place.
    }
  }, [
    persistNewChatDraft,
    authEpoch,
    inputText,
    pendingUploads,
    draftSkill,
    personaId,
    draftModelSelection,
    reasoningEffort,
    draftProjectName,
    draftDeviceFolder,
    draftAgentMention,
    uploadInFlight,
    invokeOnSend,
    hints,
    locked,
  ]);

  // Re-evaluates whether the cursor sits inside an active mention token
  // (a contiguous `@<query>` run with no whitespace, anchored at @).
  const reevaluateMentionContext = useCallback(
    (value: string, cursor: number) => {
      if (agentMentionLocked) {
        if (mentionMenuOpen) setMentionMenuOpen(false);
        return;
      }
      // Walk backwards from the cursor looking for `@`, breaking on
      // whitespace. If `@` appears at start or after whitespace it's a
      // valid mention anchor.
      let i = cursor - 1;
      while (i >= 0 && !/\s/.test(value[i])) {
        if (value[i] === "@") {
          const before = i === 0 ? "" : value[i - 1];
          if (i === 0 || /\s/.test(before)) {
            setMentionAnchorIndex(i);
            setMentionQuery(value.slice(i + 1, cursor));
            setMentionMenuOpen(true);
            return;
          }
          break;
        }
        i--;
      }
      // No active @-token under the cursor — close any open menu.
      if (mentionMenuOpen) {
        setMentionMenuOpen(false);
        setMentionAnchorIndex(null);
        setMentionQuery("");
      }
    },
    [agentMentionLocked, mentionMenuOpen],
  );

  // The slash menu is active only while the cursor sits inside a leading
  // `/<token>` (slash at index 0, no whitespace before the cursor). A single
  // internal slash is allowed only for scoped app ids (`@publisher/app`), so
  // canonical scoped skills remain pickable without treating paths such as
  // `/etc/hosts` as skill queries.
  const reevaluateSlashContext = useCallback(
    (value: string, cursor: number) => {
      const token = value.slice(1, cursor);
      const slashCount = token.split("/").length - 1;
      const slashShapeAllowed = slashCount === 0 || (token.startsWith("@") && slashCount === 1);
      if (
        !textOnly &&
        value.startsWith("/") &&
        cursor >= 1 &&
        !/\s/.test(token) &&
        slashShapeAllowed
      ) {
        setSlashQuery(token);
        setSlashMenuOpen(true);
        return;
      }
      if (slashMenuOpen) {
        setSlashMenuOpen(false);
        setSlashQuery("");
      }
    },
    [slashMenuOpen, textOnly],
  );

  const handleTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (uploadInFlightRef.current) return;
    const value = event.target.value;
    setInputText(value);
    const cursor = event.target.selectionEnd ?? value.length;
    reevaluateMentionContext(value, cursor);
    reevaluateSlashContext(value, cursor);
  };

  const handleTextareaSelect = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;
    const cursor = el.selectionEnd ?? el.value.length;
    reevaluateMentionContext(el.value, cursor);
    reevaluateSlashContext(el.value, cursor);
  };

  const acceptMention = useCallback(
    (mention: AgentMention) => {
      if (uploadInFlightRef.current) return;
      // Splice out the `@<query>` token that triggered the menu so the chip
      // becomes the single source of truth for "which agent."
      if (mentionAnchorIndex !== null) {
        const el = textareaRef.current;
        const cursor = el?.selectionEnd ?? inputText.length;
        const before = inputText.slice(0, mentionAnchorIndex);
        const after = inputText.slice(cursor);
        // Collapse the join so we don't leave a stray double-space when the
        // mention sat between two words.
        const joined =
          before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after)
            ? before + " " + after
            : before + after;
        setInputText(joined);
        requestAnimationFrame(() => {
          const t = textareaRef.current;
          if (!t) return;
          const next = before.length;
          t.focus();
          t.setSelectionRange(next, next);
        });
      }
      setDraftAgentMention(mention);
      setMentionMenuOpen(false);
      setMentionAnchorIndex(null);
      setMentionQuery("");
    },
    [inputText, mentionAnchorIndex],
  );

  const acceptSlashSkill = useCallback(
    (skill: SkillSelection) => {
      if (uploadInFlightRef.current) return;
      // Mirror acceptMention: splice out the leading `/<query>` token so the
      // chip becomes the single source of truth for "which skill" — whatever
      // the user already typed after the cursor stays as the task text.
      const el = textareaRef.current;
      const cursor = el?.selectionEnd ?? inputText.length;
      const after = inputText.slice(cursor).replace(/^\s+/, "");
      setInputText(after);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        t.setSelectionRange(0, 0);
      });
      setDraftSkill({
        name: skill.name,
        localName: skill.localName,
        description: skill.description,
        iconUrl: skill.iconUrl,
      });
      setSlashMenuOpen(false);
      setSlashQuery("");
    },
    [inputText],
  );

  const mentionMenuRef = useRef<AgentMentionMenuHandle>(null);
  const slashMenuRef = useRef<SlashSkillMenuHandle>(null);

  // On desktop, Enter submits (Shift+Enter for a newline); Stop button is
  // intentionally not bound to Enter so it doesn't race a finishing stream.
  // See the long comment in the original ChatPage for context.
  // On touch-first devices, Enter inserts a newline instead and sending goes
  // through the send button — soft keyboards have no Shift+Enter, and an
  // accidental tap on Enter shouldn't fire a half-written message.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the slash menu is open, hijack arrow/enter/escape the same way the
    // mention menu does. The two are mutually exclusive in practice: slash
    // requires the message to start with `/`, mentions require an `@` token.
    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashMenuRef.current?.move(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashMenuRef.current?.move(-1);
        return;
      }
      // Horizontal navigation mirrors the mention menu: the slash menu is the
      // same two-panel app → item picker, so ArrowRight drills into the
      // skills panel and ArrowLeft returns to apps instead of moving the
      // textarea cursor.
      if (e.key === "ArrowRight") {
        e.preventDefault();
        slashMenuRef.current?.moveHorizontal(1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        slashMenuRef.current?.moveHorizontal(-1);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        if (slashMenuRef.current?.acceptSelected()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        setSlashQuery("");
        return;
      }
    }
    // While the mention menu is open, hijack arrow/enter/escape so the user
    // can navigate without leaving the textarea. Falls through to normal
    // typing otherwise.
    if (mentionMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionMenuRef.current?.move(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionMenuRef.current?.move(-1);
        return;
      }
      // Horizontal navigation always wins over textarea cursor movement
      // when the mention menu is open. ArrowLeft from the agents panel
      // returns to apps so the user can pick a different app after a
      // mis-click; without hijacking, the cursor would slide past `@` and
      // reevaluateMentionContext would silently close the menu.
      if (e.key === "ArrowRight") {
        e.preventDefault();
        mentionMenuRef.current?.moveHorizontal(1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        mentionMenuRef.current?.moveHorizontal(-1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (mentionMenuRef.current?.acceptSelected()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMenuOpen(false);
        setMentionAnchorIndex(null);
        setMentionQuery("");
        return;
      }
    }
    if (shouldSubmitOnEnter(e, { enterSends: !coarsePointer })) {
      e.preventDefault();
      void runSend();
    }
  };

  const impersonationOptions = useMemo(
    () => people.filter((p) => p.bondLevel !== "guardian"),
    [people],
  );
  const selectedPerson = useMemo(
    () => impersonationOptions.find((p) => p.id === selectedPersonId) ?? null,
    [impersonationOptions, selectedPersonId],
  );
  const guardianLabel = guardianName
    ? t("impersonation.guardianWithName", { name: guardianName })
    : t("impersonation.guardianFallback");
  const selectedPersonLabel = selectedPerson
    ? t("impersonation.personLabel", {
        name: selectedPerson.displayName,
        bondLevel: selectedPerson.bondLevel,
      })
    : guardianLabel;

  const draftProject = projectCatalog?.projects.find((p) => p.name === draftProjectName);
  const draftProjectLabel = draftProject
    ? (draftProject.displayName ?? getProjectDisplayName(draftProject.name))
    : getProjectDisplayName(draftProjectName);

  // Live handoff (not the approve moment, which keeps its own banner). When set,
  // it's the active chip in the row and supersedes the @agent chip — both would
  // name the same specialist.
  const collaborating =
    designingInteraction && !designingInteraction.onApprove ? designingInteraction : null;
  // An in-flight upload renders the cancel control in this slot instead, so the
  // send label never has to describe one.
  const sendActionLabel = isStreaming
    ? t("composer.sendWhileRunningTitle")
    : t("composer.sendTitle");
  const showCancelUpload = uploadInFlight;
  const cancelUploadLabel = t("composer.cancelUpload");

  return (
    <>
      {/* Approve moment: one segmented button group above the tray — a plain text
          segment (the message) joined to a neutral outline Cancel and a primary
          Approve. Neutral throughout except the single Approve CTA. */}
      {designingInteraction?.onApprove && (
        <ButtonGroup className="mb-2 w-full rounded-12 shadow-card-hover">
          <ButtonGroupText className="min-w-0 flex-1 gap-2 border-border bg-surface px-3">
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              <span>{designingInteraction.agentLabel}</span> submitted a result — approve it, or
              reply to request changes
            </span>
          </ButtonGroupText>
          {designingInteraction.onCancel && (
            <Button variant="outline" size="sm" onClick={designingInteraction.onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={designingInteraction.onApprove}>
            Approve
          </Button>
        </ButtonGroup>
      )}
      {streamError && (
        <ErrorEventView
          presentation="status"
          className="mb-2"
          error={typeof streamError === "string" ? streamError : streamError.message}
          code={typeof streamError === "string" ? undefined : streamError.code}
          provider={typeof streamError === "string" ? undefined : streamError.provider}
          reason={typeof streamError === "string" ? undefined : streamError.reason}
        />
      )}
      {/* Pre-send chip tray: tucked *behind* the box, peeking out the TOP (z-0
          under the box's z-10). Bottom corners are square and the overlap (-mb-8)
          clears the box's rounded-16 corner zone, so no tray corner shows in the
          gap; only the top chip row (rounded-t-16) peeks. Scrolls horizontally
          on overflow. */}
      <div className="relative z-0 -mb-8 flex items-center gap-2 overflow-x-auto rounded-t-16 border border-border bg-surface-muted/65 px-4 pb-10 pt-2 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden supports-[backdrop-filter]:bg-surface-muted/45 empty:hidden">
        {effectiveMention && (
          // Its × cancels the live handoff while collaborating, otherwise clears
          // a removable draft mention.
          <AgentMentionChip
            mention={effectiveMention}
            pinned={pinnedAgentMention !== null}
            onRemove={
              uploadInFlight
                ? undefined
                : collaborating
                  ? collaborating.onCancel
                  : pinnedAgentMention
                    ? undefined
                    : () => setDraftAgentMention(null)
            }
            removeLabel={collaborating ? "Cancel collaboration" : undefined}
          />
        )}
        {draftSkill && (
          <SkillCommandChip
            skill={draftSkill}
            onRemove={uploadInFlight ? undefined : () => setDraftSkill(null)}
          />
        )}
        {textOnly ? null : <WorkspaceContextChips />}
      </div>
      {locked ? (
        <div
          role="status"
          data-chat-composer-locked
          className="relative z-10 flex items-center gap-3 rounded-16 border border-border bg-muted px-4 py-3 text-ui text-foreground"
        >
          <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">{lockedReason}</span>
        </div>
      ) : null}
      <div
        data-chat-composer-box
        hidden={locked}
        className={cn("@container/composer relative z-10", boxClassName)}
      >
        {composerError && (
          <Alert variant="destructive" className="mb-3 px-3 py-2">
            <AlertDescription>{composerError}</AlertDescription>
          </Alert>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelection}
        />
        {/* flow-root keeps the tray's bottom margin inside this box, so the
            measured height is the full space the tray takes from the input. */}
        <div ref={attachmentTrayRef} data-attachment-tray className="flow-root">
          <PendingUploadsList
            uploads={pendingUploads}
            onRemove={removePendingUpload}
            disabled={uploadInFlight}
            uploadProgress={uploadInFlight ? uploadProgress : undefined}
          />
        </div>
        {/* A wide composer keeps Send at the end of the toolbar row. A narrow
            one moves Send up beside the input and gives the toolbar a whole
            row that scrolls sideways, so no control wraps onto a row of its
            own. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 [grid-template-areas:'input_input'_'tools_send'] @max-[28rem]/composer:[grid-template-areas:'input_send'_'tools_tools']">
          <div className="[grid-area:input] @max-[28rem]/composer:self-center">
            <SlashSkillMenu
              ref={slashMenuRef}
              open={slashMenuOpen && !uploadInFlight}
              onOpenChange={(next) => {
                if (uploadInFlightRef.current) return;
                setSlashMenuOpen(next);
                if (!next) setSlashQuery("");
              }}
              query={slashQuery}
              onSelect={acceptSlashSkill}
              anchor={
                <div>
                  <AgentMentionMenu
                    ref={mentionMenuRef}
                    open={mentionMenuOpen && !agentMentionLocked && !uploadInFlight}
                    onOpenChange={(next) => {
                      if (uploadInFlightRef.current) return;
                      setMentionMenuOpen(next);
                      if (!next) {
                        setMentionAnchorIndex(null);
                        setMentionQuery("");
                      }
                    }}
                    query={mentionQuery}
                    onSelect={acceptMention}
                    anchor={
                      <textarea
                        ref={textareaRef}
                        value={inputText}
                        onChange={handleTextareaChange}
                        onSelect={handleTextareaSelect}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        placeholder={
                          placeholder ??
                          (pendingUploads.length > 0
                            ? t("composer.placeholderWithUploads")
                            : t(COMPOSER_HINT_KEYS[hint], {
                                shortcut: chatSearchShortcutForPlatform(),
                              }))
                        }
                        rows={1}
                        className="block w-full resize-none border-0 bg-transparent text-composer text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-0"
                        style={{
                          minHeight: TEXTAREA_MIN_HEIGHT,
                          maxHeight: `${textareaMaxHeight}px`,
                        }}
                        onInput={(e) =>
                          clampTextareaHeight(e.target as HTMLTextAreaElement, textareaMaxHeight)
                        }
                        disabled={uploadInFlight}
                      />
                    }
                  />
                </div>
              }
            />
          </div>
          <div
            {...toolbarRail.props}
            data-chat-composer-toolbar
            className="flex min-w-0 flex-wrap items-center gap-2 [grid-area:tools] [mask-image:var(--scroll-fade-mask)] [-webkit-mask-image:var(--scroll-fade-mask)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden @max-[28rem]/composer:-m-1 @max-[28rem]/composer:flex-nowrap @max-[28rem]/composer:overflow-x-auto @max-[28rem]/composer:overscroll-x-contain @max-[28rem]/composer:p-1"
          >
            {showProjectSelector && (
              <ProjectSelector
                ref={projectMenuRef}
                disabled={uploadInFlight}
                t={t}
                projectCatalog={projectCatalog}
                projectsLoading={locations.query.isPending}
                projectsError={projectsError ?? loadError}
                devices={locations.query.data?.devices ?? null}
                draftProjectName={draftProjectName}
                draftProjectLabel={draftProjectLabel}
                defaultProjectName={DEFAULT_PROJECT_NAME}
                menuOpen={draftProjectMenuOpen}
                searchQuery={projectSearchQuery}
                setSearchQuery={setProjectSearchQuery}
                createFormOpen={createProjectFormOpen}
                setCreateFormOpen={setCreateProjectFormOpen}
                newProjectName={newProjectName}
                setNewProjectName={setNewProjectName}
                creatingProject={creatingProject}
                connectOnCreate={connectOnCreate}
                setConnectOnCreate={setConnectOnCreate}
                onToggleMenu={async () => {
                  if (uploadInFlightRef.current) return;
                  const nextOpen = !draftProjectMenuOpen;
                  setDraftProjectMenuOpen(nextOpen);
                  setProjectsError(null);
                  if (!nextOpen) {
                    setProjectSearchQuery("");
                    setCreateProjectFormOpen(false);
                  } else {
                    // The menu shows the cached answer; this only refreshes it.
                    void locations.query.refetch();
                  }
                }}
                onPickProject={(name) => {
                  if (uploadInFlightRef.current) return;
                  setDraftProjectName(name);
                  setDraftDeviceFolder(null);
                  setDraftProjectMenuOpen(false);
                  setProjectSearchQuery("");
                  setCreateProjectFormOpen(false);
                }}
                deviceFolder={draftDeviceFolder}
                onPickDeviceFolder={(folder) => {
                  if (uploadInFlightRef.current) return;
                  setDraftDeviceFolder(folder);
                  setDraftProjectName(DEFAULT_PROJECT_NAME);
                  setDraftProjectMenuOpen(false);
                  setProjectSearchQuery("");
                  setCreateProjectFormOpen(false);
                }}
                onCreateProject={() => {
                  if (!uploadInFlightRef.current) void createProjectAndSelect();
                }}
              />
            )}
            {pendingConnectPath ? (
              <SourceConnect
                projectPath={pendingConnectPath}
                open={!!pendingConnectPath}
                onClose={() => setPendingConnectPath(null)}
              />
            ) : null}
            {impersonationEnabled && !textOnly && (
              <ImpersonationMenu
                disabled={uploadInFlight}
                open={impersonationMenuOpen}
                onOpenChange={(next) => {
                  if (!uploadInFlightRef.current) setImpersonationMenuOpen(next);
                }}
                selectedPersonId={selectedPersonId}
                onSelectPersonId={(id) => {
                  if (!uploadInFlightRef.current) setSelectedPersonId(id);
                }}
                options={impersonationOptions}
                selectedPerson={selectedPerson}
                selectedPersonLabel={selectedPersonLabel}
                guardianLabel={guardianLabel}
              />
            )}
            {textOnly ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadInFlight}
                aria-label={t("composer.uploadFiles")}
                title={t("composer.uploadFiles")}
                className="touch-target"
              >
                <Paperclip aria-hidden />
              </Button>
            )}
            {showModelSelector && modelSelectorEnabled && (
              <ModelSelectorMenu
                open={modelMenuOpen}
                onOpenChange={setModelMenuOpen}
                value={chatModelSelection?.value ?? largeModelSelection}
                onChange={(next) =>
                  chatModelSelection
                    ? chatModelSelection.onChange(next)
                    : void updateLargeModelSelection(next)
                }
                disabled={uploadInFlight}
              />
            )}
            {textOnly ? null : (
              <ReasoningEffortMenu
                open={reasoningMenuOpen}
                onOpenChange={setReasoningMenuOpen}
                value={reasoningEffort}
                onChange={(next) => void updateReasoningEffort(next)}
                disabled={uploadInFlight}
              />
            )}
          </div>
          {/* Stop sits just left of Send. */}
          <div className="flex items-center gap-2 self-end [grid-area:send]">
            {isStreaming && onStop && (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onStop}
                className="touch-target"
                title={t("composer.stopGenerating")}
                aria-label={t("composer.stopGenerating")}
              >
                <span aria-hidden="true" className="inline-block size-2.5 bg-foreground" />
              </Button>
            )}
            {showCancelUpload ? (
              <Button
                variant="secondary"
                size="icon-sm"
                onClick={cancelUpload}
                title={cancelUploadLabel}
                aria-label={cancelUploadLabel}
                className="touch-target"
              >
                <X aria-hidden />
              </Button>
            ) : (
              <Button
                variant={
                  !inputText.trim() && pendingUploads.length === 0 && !draftSkill
                    ? "secondary"
                    : "default"
                }
                size="icon-sm"
                // A press on Send must not take focus from the textarea: on a
                // phone that blur closes the soft keyboard after every turn.
                // Cancelling mousedown keeps focus in place. Some mobile
                // browsers still blur on the tap, so the click restores focus
                // while it is still a user gesture, which iOS requires for the
                // keyboard to stay up.
                onPointerDown={() => {
                  textareaFocusedAtPressRef.current =
                    document.activeElement === textareaRef.current;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const textarea = textareaRef.current;
                  if (
                    textareaFocusedAtPressRef.current &&
                    textarea &&
                    document.activeElement !== textarea
                  ) {
                    textarea.focus({ preventScroll: true });
                  }
                  textareaFocusedAtPressRef.current = false;
                  void runSend();
                }}
                disabled={
                  uploadInFlight ||
                  (!inputText.trim() && pendingUploads.length === 0 && !draftSkill)
                }
                title={sendActionLabel}
                aria-label={sendActionLabel}
                className="touch-target"
              >
                <ArrowUp aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
});
