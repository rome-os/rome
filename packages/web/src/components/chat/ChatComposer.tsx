import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Lock, Paperclip, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { ProjectSelector } from "@/components/project-selector";
import { SourceConnect } from "@/components/sync/SourceConnect";
import { cn } from "@/lib/utils";
import { extractFilesFromClipboard } from "@/lib/clipboard-files";
import {
  ChatApiError,
  createProject as apiCreateProject,
  listProjects,
  saveSetting,
} from "@/lib/chat-api";
import { useInvalidateSettings, useSettings } from "@/hooks/use-settings";
import { usePeople } from "@/hooks/use-people";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import {
  DEFAULT_LARGE_MODEL_SELECTION,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REASONING_EFFORT,
  LARGE_MODEL_OPTIONS,
} from "@/lib/chat-constants";
import { formatProjectLabel, isReasoningEffort } from "@/lib/chat-helpers";
import { shouldSubmitOnEnter } from "@/lib/keyboard-submit";
import type {
  AgentMention,
  PendingUpload,
  ProjectCatalog,
  ProjectOption,
  ReasoningEffort,
  ChatErrorNotice,
} from "@/lib/chat-types";
import { ErrorBlock } from "./blocks/ErrorBlock";
import { AgentMentionChip } from "./composer/AgentMentionChip";
import { AgentMentionMenu, type AgentMentionMenuHandle } from "./composer/AgentMentionMenu";
import { ImpersonationMenu } from "./composer/ImpersonationMenu";
import { ModelSelectorMenu } from "./composer/ModelSelectorMenu";
import { PendingUploadsList } from "./composer/PendingUploadsList";
import { ReasoningEffortMenu } from "./composer/ReasoningEffortMenu";
import { SkillCommandChip, type SkillSelection } from "./composer/SkillCommandChip";
import { SlashSkillMenu, type SlashSkillMenuHandle } from "./composer/SlashSkillMenu";
import { WorkspaceContextChips } from "./composer/WorkspaceContextChips";

export interface ChatComposerSnapshot {
  text: string;
  uploads: PendingUpload[];
  personaId?: string;
  largeModelSelection?: string;
  reasoningEffort: ReasoningEffort;
  projectPath: string;
  // Set only in draft mode when the user picked an `@app/agent` from the
  // mention menu. Active sessions inherit their agent from `pinnedAgentMention`
  // instead — `onSend` for those should ignore this field.
  agentMention?: AgentMention;
  // The structured skill selection (the `/` chip) is sent as the
  // turn's `skillName` field; `text` carries only the task.
  skillName?: string;
}

export interface ChatComposerSendControls {
  /** `null` means the browser cannot determine the multipart body size. */
  onUploadProgress: (progress: number | null) => void;
}

export interface ChatComposerHandle {
  focus: () => void;
  insertText: (text: string) => void;
  setAgentMention: (mention: AgentMention | null) => void;
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
  // Whether the project picker is shown (typically only in draft mode).
  showProjectSelector?: boolean;
  // Whether the large-model picker is shown (typically only in draft mode).
  showModelSelector?: boolean;
  // Seed for the draft project name. Honored once at mount and again when it
  // changes from undefined → defined (i.e., transitioning into a new draft).
  initialProjectName?: string;
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
  // Disable the entire composer (e.g., while the host is initializing).
  disabled?: boolean;
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
  // When set, the composer is read-only and shows this hint instead of
  // accepting input. Used while a design interaction holds the floor: the
  // guardian is suspended, so its "main" view can be read but not typed into
  // until the design resolves.
  disabledHint?: string | null;
  // Styling for the input box itself (border, surface, padding, blur). The
  // composer owns the box so the pre-send chip row can sit *outside* it; each
  // mount passes its own box look (the floating composer adds backdrop-blur).
  boxClassName?: string;
  // Called when the user submits. The composer clears text immediately but
  // keeps uploading attachments visible until this promise settles. If it
  // rejects, the submitted inputs remain available for a retry.
  onSend: (
    snapshot: ChatComposerSnapshot,
    controls: ChatComposerSendControls,
  ) => void | Promise<void>;
}

// The empty input is one line box tall, expressed as `1lh` so it resolves
// against whatever `text-body` currently is rather than restating the role's
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

function clampTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
  el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  {
    showProjectSelector = false,
    showModelSelector = false,
    initialProjectName,
    pinnedAgentMention = null,
    initialAgentMention = null,
    lockAgentMention = false,
    disabled = false,
    isStreaming = false,
    onStop,
    streamError,
    designingInteraction = null,
    disabledHint = null,
    boxClassName,
    onSend,
  },
  ref,
) {
  const { t } = useTranslation("chat");

  const [inputText, setInputText] = useState("");
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [uploadInFlight, setUploadInFlight] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  // When `pinnedAgentMention` is set, the session is already bound to an
  // agent — the `@` menu and the local draftAgentMention are inert.
  const [draftAgentMention, setDraftAgentMention] = useState<AgentMention | null>(
    initialAgentMention,
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

  // Open while the message starts with `/` and the cursor is still inside the
  // first token. Selecting pins the skill as a structured chip (mirroring the
  // `@` mention) — the turn carries it as a `skillName` field, so no
  // name-shape constraint applies. Expansion stays server-side.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [draftSkill, setDraftSkill] = useState<SkillSelection | null>(null);

  const { data: settings } = useSettings();
  const { data: peopleData } = usePeople();
  const invalidateSettings = useInvalidateSettings();
  const people = peopleData ?? [];
  const modelSelectorEnabled = settings?.enableModelSelector === true;
  const impersonationEnabled = settings?.enableImpersonation === true;
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
  const [selectedPersonId, setSelectedPersonId] = useState<string>("");

  const [impersonationMenuOpen, setImpersonationMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);

  const [draftProjectName, setDraftProjectName] = useState(
    initialProjectName?.trim() || DEFAULT_PROJECT_NAME,
  );
  const [projectCatalog, setProjectCatalog] = useState<ProjectCatalog | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  // State drives the UI, while the ref closes the same-event gap before React
  // commits that state (for example, two rapid Enter keydown events).
  const uploadInFlightRef = useRef(false);

  // Resize the textarea to fit its content. The `onInput` handler below also
  // runs this math, but only on user typing — programmatic clears (e.g. the
  // optimistic reset in `runSend` after a send) don't fire `input`, so the
  // box would otherwise stay at its previous (potentially maxed-out) height
  // and not shrink back to a single line. We mirror the onInput math here
  // and let React re-apply it after every value change.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    clampTextareaHeight(el);
  }, [inputText]);

  //      draft seed via location.state), update the chip — but only while we
  //      still have the default-or-stale value so we don't trample on a
  //      project the user explicitly picked from the menu.
  const initialProjectNameRef = useRef(initialProjectName);
  useEffect(() => {
    const next = initialProjectName?.trim() || DEFAULT_PROJECT_NAME;
    if (next === draftProjectName) {
      initialProjectNameRef.current = initialProjectName;
      return;
    }
    if (draftProjectName === (initialProjectNameRef.current?.trim() || DEFAULT_PROJECT_NAME)) {
      setDraftProjectName(next);
    }
    initialProjectNameRef.current = initialProjectName;
  }, [initialProjectName, draftProjectName]);

  // If impersonation gets disabled mid-session, drop any selection so the
  // composer doesn't carry a hidden persona id.
  useEffect(() => {
    if (impersonationEnabled) return;
    setSelectedPersonId("");
    setImpersonationMenuOpen(false);
  }, [impersonationEnabled]);

  const updateLargeModelSelection = useCallback(
    async (next: string) => {
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

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const data = await listProjects();
      setProjectCatalog(data);
    } catch (error) {
      const fallback = t("project.errors.loadFailed");
      setProjectsError(error instanceof ChatApiError && error.message ? error.message : fallback);
    } finally {
      setProjectsLoading(false);
    }
  }, [t]);

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
      setProjectCatalog((prev) => {
        if (!prev) return prev;
        const projects = [...prev.projects, data].sort((a, b) => a.name.localeCompare(b.name));
        return { ...prev, projects };
      });
      setNewProjectName("");
      setCreateProjectFormOpen(false);
      setProjectSearchQuery("");
      setDraftProjectName(data.name);
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
  }, [newProjectName, t, connectOnCreate]);

  const addPendingFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setPendingUploads((prev) => [
      ...prev,
      ...files.map((file) => ({ id: crypto.randomUUID(), file })),
    ]);
  }, []);

  const invokeOnSend = useCallback(
    async (snapshot: ChatComposerSnapshot) => {
      const tracksUpload = snapshot.uploads.length > 0;
      if (tracksUpload) {
        uploadInFlightRef.current = true;
        setUploadInFlight(true);
        setUploadProgress(0);
      }
      try {
        await onSend(snapshot, {
          onUploadProgress: (progress) => {
            if (!tracksUpload) return;
            setUploadProgress(progress === null ? null : Math.max(0, Math.min(1, progress)));
          },
        });
      } finally {
        if (tracksUpload) {
          uploadInFlightRef.current = false;
          setUploadInFlight(false);
          setUploadProgress(null);
        }
      }
    },
    [onSend],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      insertText: (text: string) => {
        setInputText(text);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          clampTextareaHeight(el);
          el.focus();
          el.setSelectionRange(text.length, text.length);
        });
      },
      setAgentMention: (mention: AgentMention | null) => {
        if (agentMentionLocked) return;
        // Mirror acceptMention's cleanup: scoping the draft programmatically
        // must also dismiss any open `@` menu, or its stale anchor/query keeps
        // intercepting Enter/arrow keys against the wrong token.
        setDraftAgentMention(mention);
        setMentionMenuOpen(false);
        setMentionAnchorIndex(null);
        setMentionQuery("");
      },
      setSkillSelection: (skill: SkillSelection | null) => {
        setDraftSkill(skill);
        setSlashMenuOpen(false);
        setSlashQuery("");
      },
      addFiles: addPendingFiles,
      submit: (text: string, opts?: { skillName?: string }) => {
        if (disabled || disabledHint != null || uploadInFlightRef.current) return;
        const trimmed = text.trim();
        const skillName = opts?.skillName ?? draftSkill?.name;
        if (!trimmed && pendingUploads.length === 0 && !skillName) return;
        const snapshot: ChatComposerSnapshot = {
          text: trimmed,
          uploads: pendingUploads,
          personaId: impersonationEnabled && selectedPersonId ? selectedPersonId : undefined,
          largeModelSelection:
            showModelSelector && modelSelectorEnabled ? largeModelSelection : undefined,
          reasoningEffort,
          projectPath: draftProjectName,
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
        personaId: impersonationEnabled && selectedPersonId ? selectedPersonId : undefined,
        reasoningEffort,
      }),
    }),
    [
      addPendingFiles,
      impersonationEnabled,
      selectedPersonId,
      reasoningEffort,
      agentMentionLocked,
      disabled,
      disabledHint,
      draftSkill,
      pendingUploads,
      showModelSelector,
      modelSelectorEnabled,
      largeModelSelection,
      draftProjectName,
      draftAgentMention,
      onSend,
      invokeOnSend,
    ],
  );

  const removePendingUpload = useCallback((id: string) => {
    setPendingUploads((prev) => prev.filter((upload) => upload.id !== id));
  }, []);

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    addPendingFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = extractFilesFromClipboard(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        addPendingFiles(files);
      }
    },
    [addPendingFiles, disabled],
  );

  const isComposerBusy = disabled || disabledHint != null;

  const runSend = useCallback(async () => {
    if (isComposerBusy || uploadInFlightRef.current) return;
    // A skill chip alone is a sendable turn — the server-expanded prompt asks
    // the agent to read the skill and ask what to do with it.
    if (!inputText.trim() && pendingUploads.length === 0 && !draftSkill) return;

    const text = inputText.trim();
    const uploads = pendingUploads;
    const skill = draftSkill;
    const snapshot: ChatComposerSnapshot = {
      text,
      uploads,
      personaId: impersonationEnabled && selectedPersonId ? selectedPersonId : undefined,
      largeModelSelection:
        showModelSelector && modelSelectorEnabled ? largeModelSelection : undefined,
      reasoningEffort,
      projectPath: draftProjectName,
      // Pinned sessions ignore this; draft hosts read it to lock the new
      // session to the picked agent.
      agentMention: draftAgentMention ?? undefined,
      skillName: skill?.name,
    };

    // Optimistically clear so the user sees the input wipe immediately. If
    // onSend rejects, restore the snapshot so they can retry without
    // re-typing.
    setInputText("");
    if (uploads.length === 0) setPendingUploads([]);
    setDraftSkill(null);
    try {
      await invokeOnSend(snapshot);
      if (uploads.length > 0) {
        const sentIds = new Set(uploads.map((upload) => upload.id));
        setPendingUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
      }
    } catch {
      setInputText(text);
      if (uploads.length === 0) setPendingUploads(uploads);
      setDraftSkill(skill);
    }
  }, [
    inputText,
    pendingUploads,
    draftSkill,
    impersonationEnabled,
    selectedPersonId,
    showModelSelector,
    modelSelectorEnabled,
    largeModelSelection,
    reasoningEffort,
    draftProjectName,
    draftAgentMention,
    isComposerBusy,
    invokeOnSend,
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
      if (value.startsWith("/") && cursor >= 1 && !/\s/.test(token) && slashShapeAllowed) {
        setSlashQuery(token);
        setSlashMenuOpen(true);
        return;
      }
      if (slashMenuOpen) {
        setSlashMenuOpen(false);
        setSlashQuery("");
      }
    },
    [slashMenuOpen],
  );

  const handleTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
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
  const coarsePointer = useCoarsePointer();
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
    ? (draftProject.displayName ?? formatProjectLabel(draftProject.name))
    : formatProjectLabel(draftProjectName);

  // Live handoff (not the approve moment, which keeps its own banner). When set,
  // it's the active chip in the row and supersedes the @agent chip — both would
  // name the same specialist.
  const collaborating =
    designingInteraction && !designingInteraction.onApprove ? designingInteraction : null;

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
        <ErrorBlock
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
              collaborating
                ? collaborating.onCancel
                : pinnedAgentMention
                  ? undefined
                  : () => setDraftAgentMention(null)
            }
            removeLabel={collaborating ? "Cancel collaboration" : undefined}
          />
        )}
        {draftSkill && <SkillCommandChip skill={draftSkill} onRemove={() => setDraftSkill(null)} />}
        <WorkspaceContextChips />
      </div>
      <div data-chat-composer-box className={cn("relative z-10", boxClassName)}>
        {disabledHint && (
          <div className="mb-3 flex items-center gap-2 rounded-8 border border-border bg-surface-muted px-3 py-2 text-ui text-muted-foreground">
            <Lock className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{disabledHint}</span>
          </div>
        )}
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
        <PendingUploadsList
          uploads={pendingUploads}
          onRemove={removePendingUpload}
          disabled={isComposerBusy || uploadInFlight}
          uploadProgress={uploadInFlight ? uploadProgress : undefined}
        />
        <SlashSkillMenu
          ref={slashMenuRef}
          open={slashMenuOpen && !isComposerBusy}
          onOpenChange={(next) => {
            setSlashMenuOpen(next);
            if (!next) setSlashQuery("");
          }}
          query={slashQuery}
          onSelect={acceptSlashSkill}
          anchor={
            <div>
              <AgentMentionMenu
                ref={mentionMenuRef}
                open={mentionMenuOpen && !agentMentionLocked}
                onOpenChange={(next) => {
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
                      pendingUploads.length > 0
                        ? t("composer.placeholderWithUploads")
                        : t("composer.placeholderDefault")
                    }
                    rows={1}
                    className="block w-full resize-none border-0 bg-transparent text-body text-foreground placeholder:text-subtle-foreground focus:outline-none focus:ring-0"
                    style={{
                      minHeight: TEXTAREA_MIN_HEIGHT,
                      maxHeight: `${TEXTAREA_MAX_HEIGHT}px`,
                    }}
                    onInput={(e) => clampTextareaHeight(e.target as HTMLTextAreaElement)}
                    disabled={isComposerBusy}
                  />
                }
              />
            </div>
          }
        />
        <div
          data-chat-composer-toolbar
          className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2"
        >
          {showProjectSelector && (
            <ProjectSelector
              ref={projectMenuRef}
              t={t}
              projectCatalog={projectCatalog}
              projectsLoading={projectsLoading}
              projectsError={projectsError}
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
                const nextOpen = !draftProjectMenuOpen;
                setDraftProjectMenuOpen(nextOpen);
                setProjectsError(null);
                if (!nextOpen) {
                  setProjectSearchQuery("");
                  setCreateProjectFormOpen(false);
                } else if (!projectCatalog) {
                  await loadProjects();
                }
              }}
              onPickProject={(name) => {
                setDraftProjectName(name);
                setDraftProjectMenuOpen(false);
                setProjectSearchQuery("");
                setCreateProjectFormOpen(false);
              }}
              onCreateProject={() => createProjectAndSelect()}
            />
          )}
          {pendingConnectPath ? (
            <SourceConnect
              mode="link"
              projectPath={pendingConnectPath}
              open={!!pendingConnectPath}
              onClose={() => setPendingConnectPath(null)}
            />
          ) : null}
          {impersonationEnabled && (
            <ImpersonationMenu
              open={impersonationMenuOpen}
              onOpenChange={setImpersonationMenuOpen}
              selectedPersonId={selectedPersonId}
              onSelectPersonId={setSelectedPersonId}
              options={impersonationOptions}
              selectedPerson={selectedPerson}
              selectedPersonLabel={selectedPersonLabel}
              guardianLabel={guardianLabel}
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isComposerBusy || uploadInFlight}
            aria-label={t("composer.uploadFiles")}
            title={t("composer.uploadFiles")}
            className="touch-target"
          >
            <Paperclip aria-hidden />
          </Button>
          {showModelSelector && modelSelectorEnabled && (
            <ModelSelectorMenu
              open={modelMenuOpen}
              onOpenChange={setModelMenuOpen}
              value={largeModelSelection}
              onChange={(next) => void updateLargeModelSelection(next)}
              disabled={isComposerBusy}
            />
          )}
          <ReasoningEffortMenu
            open={reasoningMenuOpen}
            onOpenChange={setReasoningMenuOpen}
            value={reasoningEffort}
            onChange={(next) => void updateReasoningEffort(next)}
            disabled={isComposerBusy}
          />
          {/* Stop + Send cluster on the right; Stop sits just left of Send. */}
          <div className="ml-auto flex items-center gap-2">
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
            <Button
              variant={
                !inputText.trim() && pendingUploads.length === 0 && !draftSkill
                  ? "secondary"
                  : "default"
              }
              size="icon-sm"
              onClick={() => void runSend()}
              disabled={
                isComposerBusy ||
                uploadInFlight ||
                (!inputText.trim() && pendingUploads.length === 0 && !draftSkill)
              }
              title={
                uploadInFlight
                  ? t("composer.uploadingFiles")
                  : isStreaming
                    ? t("composer.sendWhileRunningTitle")
                    : t("composer.sendTitle")
              }
              aria-label={
                uploadInFlight
                  ? t("composer.uploadingFiles")
                  : isStreaming
                    ? t("composer.sendWhileRunningTitle")
                    : t("composer.sendTitle")
              }
              className="touch-target"
            >
              <ArrowUp aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
});
