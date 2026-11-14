import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Cpu,
  Folder,
  FolderOpen,
  Laptop,
  MoreHorizontal,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  ChatComposerHandle,
  ChatComposerSendControls,
  ChatComposerSnapshot,
} from "@/components/chat/ChatComposer";
import { ProjectSelector } from "@/components/project-selector";
import { useChatLocations } from "@/hooks/use-chat-locations";
import { useSettings } from "@/hooks/use-settings";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import {
  COMMON_LARGE_MODEL_IDS,
  DEFAULT_LARGE_MODEL_SELECTION,
  DEFAULT_PROJECT_NAME,
  DEFAULT_REASONING_EFFORT,
  LARGE_MODEL_OPTIONS,
} from "@/lib/chat-constants";
import { isReasoningEffort } from "@/lib/chat-helpers";
import { extractFilesFromClipboard } from "@/lib/clipboard-files";
import { shouldSubmitOnEnter } from "@/lib/keyboard-submit";
import { randomUUID } from "@/lib/random-uuid";
import type { ChatErrorNotice, PendingUpload } from "@/lib/chat-types";
import { appendFolderLine, deviceFolderLabel, type FolderSelection } from "@/lib/device-folder";
import { cn } from "@/lib/utils";
import { ErrorEventView } from "../entries/ErrorEventView";
import { ReplyBar } from "../reply/ReplyBar";
import { useReplyDraft } from "../reply/reply-draft";
import { ComposerChip } from "./ComposerChip";
import { PendingUploadsList } from "./PendingUploadsList";
import { useFittedPlaceholder } from "./use-fitted-placeholder";
import { useSlashSkill } from "./use-slash-skill";
import { SkillCommandChip, type SkillSelection } from "./SkillCommandChip";
import { SlashSkillMenu } from "./SlashSkillMenu";
import { useVoiceInput } from "./use-voice-input";
import { VoiceInputButton, VoiceInputNotice } from "./VoiceInputControl";
import type { ReplyTarget } from "../reply/reply-draft";

const TEXTAREA_MAX_HEIGHT = 240;

function clampTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
  el.style.overflowY = el.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
}

export interface ConciergeComposerProps {
  /** The box look; the floating mount adds its blur and translucency. */
  boxClassName?: string;
  /** Whether a turn is running. Sending still works: the next message interrupts. */
  isStreaming?: boolean;
  onStop?: () => void;
  streamError?: string | ChatErrorNotice | null;
  /** An open topic chat's own name, which the placeholder says it is a message "in". Unset in the main chat. */
  chatName?: string | null;
  /** The chat's own model pick. Unset hides the model row. */
  modelSelection?: { value: string; onChange: (next: string) => void };
  onSend: (
    snapshot: ChatComposerSnapshot,
    controls: ChatComposerSendControls,
  ) => void | Promise<void>;
}

/**
 * The Concierge chat's composer: one line of text between a `+` and Send.
 * The `+` menu holds file upload and a model submenu, the only two things a
 * texting conversation changes. It sends what `ChatComposer` sends, so the
 * chat posts its turns the same way.
 */
export const ConciergeComposer = forwardRef<ChatComposerHandle, ConciergeComposerProps>(
  function ConciergeComposer(
    { boxClassName, isStreaming = false, onStop, streamError, chatName, modelSelection, onSend },
    ref,
  ) {
    const { t } = useTranslation("chat");
    const replyDraft = useReplyDraft();
    const { data: settings } = useSettings();
    const coarsePointer = useCoarsePointer();
    // Turns carry the dashboard's reasoning effort, as in every other chat.
    const reasoningEffort = isReasoningEffort(settings?.webchatReasoningEffort)
      ? settings.webchatReasoningEffort
      : DEFAULT_REASONING_EFFORT;

    const [inputText, setInputText] = useState("");
    const [draftSkill, setDraftSkill] = useState<SkillSelection | null>(null);
    const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
    const [uploadInFlight, setUploadInFlight] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);
    // One folder for the next message only; it goes out as a line of text.
    const [folder, setFolder] = useState<FolderSelection | null>(null);
    const [folderPickerOpen, setFolderPickerOpen] = useState(false);
    const [folderSearch, setFolderSearch] = useState("");
    // Set by the menu item, read once the menu has closed and returned focus.
    const openPickerAfterCloseRef = useRef(false);
    const locations = useChatLocations(folderPickerOpen);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // An open topic chat's own name, shortened to fit the box's one line.
    const namedPlaceholder = useFittedPlaceholder(textareaRef, chatName, (name) =>
      t("concierge.placeholderIn", { name }),
    );
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaFocusedAtPressRef = useRef(false);
    // The ref closes the same-event gap before React commits the state.
    const uploadInFlightRef = useRef(false);
    const {
      slashMenuOpen,
      setSlashMenuOpen,
      slashQuery,
      setSlashQuery,
      slashMenuRef,
      reevaluateSlashContext,
      acceptSlashSkill,
      handleSlashKeyDown,
    } = useSlashSkill({
      inputText,
      setInputText,
      setDraftSkill,
      textareaRef,
      uploadInFlightRef,
    });
    const uploadAbortRef = useRef<AbortController | null>(null);
    // The last failed send, so a retry of the same input reuses its inputId.
    const failedSendRef = useRef<{
      inputId: string;
      text: string;
      uploads: PendingUpload[];
      folder: FolderSelection | null;
      skill: SkillSelection | null;
    } | null>(null);

    const voice = useVoiceInput({ textareaRef, value: inputText, setValue: setInputText });

    // Programmatic clears fire no `input` event, so resize on every change.
    useLayoutEffect(() => {
      if (textareaRef.current) clampTextareaHeight(textareaRef.current);
    }, [inputText]);

    const addPendingFiles = useCallback((files: File[]) => {
      if (files.length === 0 || uploadInFlightRef.current) return;
      setPendingUploads((prev) => [...prev, ...files.map((file) => ({ id: randomUUID(), file }))]);
    }, []);

    const invokeOnSend = useCallback(
      async (snapshot: ChatComposerSnapshot) => {
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

    const snapshotOf = useCallback(
      (
        text: string,
        uploads: PendingUpload[],
        inputId?: string,
        replyTo?: ReplyTarget,
        pickedFolder: FolderSelection | null = null,
        skillName?: string,
        chatThread?: string,
      ): ChatComposerSnapshot => ({
        text: appendFolderLine(text, pickedFolder),
        uploads,
        reasoningEffort,
        // A session keeps its project; the field is only read for a draft.
        projectPath: DEFAULT_PROJECT_NAME,
        inputId,
        replyTo,
        skillName,
        ...(chatThread ? { chatThread } : {}),
      }),
      [reasoningEffort],
    );

    const runSend = useCallback(async () => {
      if (uploadInFlightRef.current || voice.active) return;
      const text = inputText.trim();
      const rawText = inputText;
      const uploads = pendingUploads;
      const pickedFolder = folder;
      const skill = draftSkill;
      if (!text && uploads.length === 0 && !pickedFolder && !skill) return;
      const failed = failedSendRef.current;
      const inputId =
        failed &&
        failed.text === text &&
        failed.uploads === uploads &&
        failed.folder === pickedFolder &&
        failed.skill === skill
          ? failed.inputId
          : randomUUID();
      // Text alone clears at once and comes back on failure. Attachments keep
      // the text on screen until the server accepts the upload.
      const clearsOptimistically = uploads.length === 0;
      const replyTo = replyDraft?.target ?? undefined;
      const chatThread = replyDraft?.thread ?? undefined;
      const chatThreadTitle = replyDraft?.threadTitle ?? "";
      // The draft's change count once this send cleared it: a failed send
      // puts its reply back only if the guardian changed nothing since.
      let clearedAt: number | undefined;
      if (clearsOptimistically) {
        setInputText("");
        setPendingUploads([]);
        setFolder(null);
        setDraftSkill(null);
        // A send closes the reply bar and, with it, the thread view; the
        // message keeps the thread it was sent into.
        clearedAt = replyDraft?.clear();
      }
      try {
        await invokeOnSend(
          snapshotOf(text, uploads, inputId, replyTo, pickedFolder, skill?.name, chatThread),
        );
        failedSendRef.current = null;
        if (!clearsOptimistically) {
          replyDraft?.clear();
          const sentIds = new Set(uploads.map((upload) => upload.id));
          setPendingUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
          setInputText((current) => (current === rawText ? "" : current));
          setFolder((current) => (current === pickedFolder ? null : current));
          setDraftSkill((current) => (current === skill ? null : current));
        }
      } catch {
        failedSendRef.current = { inputId, text, uploads, folder: pickedFolder, skill };
        if (clearsOptimistically) {
          setInputText(text);
          setPendingUploads(uploads);
          setFolder(pickedFolder);
          setDraftSkill(skill);
          replyDraft?.restore(
            {
              ...(replyTo ? { target: replyTo } : {}),
              ...(chatThread ? { thread: { thread: chatThread, title: chatThreadTitle } } : {}),
            },
            clearedAt,
          );
        }
      }
    }, [
      inputText,
      pendingUploads,
      folder,
      draftSkill,
      invokeOnSend,
      snapshotOf,
      replyDraft,
      voice.active,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
        insertText: (text, options) => {
          if (uploadInFlightRef.current) return;
          setInputText(text);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            if (options?.focus !== false) el.focus();
            el.setSelectionRange(text.length, text.length);
          });
        },
        setSkillSelection: (skill) => {
          if (uploadInFlightRef.current) return;
          setDraftSkill(skill);
          setSlashMenuOpen(false);
          setSlashQuery("");
        },
        addFiles: addPendingFiles,
        submit: (text, options) => {
          const trimmed = text.trim();
          const skillName = options?.skillName ?? draftSkill?.name;
          if (uploadInFlightRef.current || (!trimmed && pendingUploads.length === 0 && !skillName))
            return;
          const uploads = pendingUploads;
          void invokeOnSend(snapshotOf(trimmed, uploads, undefined, undefined, null, skillName))
            .then(() => {
              const sentIds = new Set(uploads.map((upload) => upload.id));
              setPendingUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
            })
            .catch(() => {
              // The chat shows the error; the inputs stay for a retry.
            });
        },
        getMetadataSnapshot: () => ({ reasoningEffort }),
      }),
      [
        addPendingFiles,
        pendingUploads,
        invokeOnSend,
        snapshotOf,
        reasoningEffort,
        draftSkill,
        setSlashMenuOpen,
        setSlashQuery,
      ],
    );

    const empty = !inputText.trim() && pendingUploads.length === 0 && !folder && !draftSkill;
    const sendLabel = isStreaming ? t("composer.sendWhileRunningTitle") : t("composer.sendTitle");
    const showModel = !!modelSelection;
    const [showAllModels, setShowAllModels] = useState(false);
    // Like the model picker in other chats: the common models and the chat's
    // own pick first, every model after "show all".
    const modelRows = (value: string) =>
      showAllModels
        ? LARGE_MODEL_OPTIONS
        : LARGE_MODEL_OPTIONS.filter(
            (option) => COMMON_LARGE_MODEL_IDS.includes(option.id) || option.id === value,
          );
    const modelLabel = (id: string) =>
      t(
        (
          LARGE_MODEL_OPTIONS.find((option) => option.id === id) ??
          LARGE_MODEL_OPTIONS.find((option) => option.id === DEFAULT_LARGE_MODEL_SELECTION)!
        ).labelKey,
      );

    return (
      <>
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
        <form
          data-chat-composer-box
          className={cn("relative z-10", boxClassName)}
          onSubmit={(event) => event.preventDefault()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addPendingFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <ReplyBar />
          <VoiceInputNotice reason={voice.notice} />
          {draftSkill && (
            <div className="mb-2 flex min-w-0">
              <SkillCommandChip
                skill={draftSkill}
                onRemove={uploadInFlight ? undefined : () => setDraftSkill(null)}
              />
            </div>
          )}
          <div className="flow-root empty:hidden">
            <PendingUploadsList
              uploads={pendingUploads}
              onRemove={(id) => {
                if (uploadInFlightRef.current) return;
                setPendingUploads((prev) => prev.filter((upload) => upload.id !== id));
              }}
              disabled={uploadInFlight}
              uploadProgress={uploadInFlight ? uploadProgress : undefined}
            />
            {folder ? (
              <div className="mb-2">
                <ComposerChip
                  icon={
                    folder.kind === "device" ? (
                      <Laptop className="size-3.5" aria-hidden />
                    ) : (
                      <Folder className="size-3.5" aria-hidden />
                    )
                  }
                  title={folder.kind === "device" ? folder.folder.path : folder.path}
                  removeLabel={t("concierge.removeFolder")}
                  onRemove={uploadInFlight ? undefined : () => setFolder(null)}
                >
                  {folder.kind === "device" ? deviceFolderLabel(folder.folder) : folder.name}
                </ComposerChip>
              </div>
            ) : null}
          </div>
          <div className="flex items-end gap-2">
            {/* The selector anchors to this box: the popover opens above the +. */}
            <div className="relative flex">
              <DropdownMenu
                onOpenChange={(open) => {
                  // Each open starts on the short model list.
                  if (!open) setShowAllModels(false);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={uploadInFlight}
                    aria-label={t("concierge.composerMenu")}
                    title={t("concierge.composerMenu")}
                    className="touch-target"
                  >
                    <Plus aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-44"
                  // The menu hands focus back to the +, which the popover would
                  // read as a click outside and close at once. Skip that return
                  // and open the selector instead.
                  onCloseAutoFocus={(event) => {
                    if (!openPickerAfterCloseRef.current) return;
                    openPickerAfterCloseRef.current = false;
                    event.preventDefault();
                    setFolderPickerOpen(true);
                  }}
                >
                  <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                    <Paperclip aria-hidden />
                    {t("composer.uploadFiles")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      openPickerAfterCloseRef.current = true;
                    }}
                  >
                    <FolderOpen aria-hidden />
                    {t("concierge.chooseFolder")}
                  </DropdownMenuItem>
                  {showModel && modelSelection ? (
                    <DropdownMenuSub>
                      {/* The trigger's own chevron is its last svg; `ml-0` lets the
                        current model, not a split gap, take the free space. */}
                      <DropdownMenuSubTrigger className="[&>svg:last-child]:ml-0">
                        <Cpu aria-hidden />
                        {t("modelSelector.label")}
                        <span className="ml-auto truncate text-muted-foreground">
                          {modelLabel(modelSelection.value)}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-80 w-48 overflow-y-auto">
                        <DropdownMenuRadioGroup
                          value={modelSelection.value}
                          onValueChange={modelSelection.onChange}
                        >
                          {modelRows(modelSelection.value).map((option) => (
                            <DropdownMenuRadioItem key={option.id} value={option.id}>
                              {t(option.labelKey)}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                        {showAllModels ? null : (
                          <DropdownMenuItem
                            className="text-muted-foreground"
                            // Expands the list in place instead of closing the menu.
                            onSelect={(event) => {
                              event.preventDefault();
                              setShowAllModels(true);
                            }}
                          >
                            <MoreHorizontal aria-hidden />
                            {t("modelSelector.showAll", {
                              count: LARGE_MODEL_OPTIONS.length,
                            })}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <ProjectSelector
                hideTrigger
                t={t}
                projectCatalog={locations.query.data?.projects ?? null}
                projectsLoading={locations.query.isPending}
                projectsError={
                  locations.query.error && !locations.query.data
                    ? t("project.errors.loadFailed")
                    : null
                }
                devices={locations.query.data?.devices ?? null}
                draftProjectName={folder?.kind === "project" ? folder.name : DEFAULT_PROJECT_NAME}
                draftProjectLabel={folder?.kind === "project" ? folder.name : DEFAULT_PROJECT_NAME}
                defaultProjectName={DEFAULT_PROJECT_NAME}
                deviceFolder={folder?.kind === "device" ? folder.folder : null}
                menuOpen={folderPickerOpen}
                searchQuery={folderSearch}
                setSearchQuery={setFolderSearch}
                onToggleMenu={() => {
                  setFolderPickerOpen((open) => !open);
                  setFolderSearch("");
                }}
                onPickProject={(name) => {
                  const project = locations.query.data?.projects.projects.find(
                    (candidate) => candidate.name === name,
                  );
                  // The default project is "no project": it clears the pick.
                  // `path` is the project's absolute folder.
                  setFolder(
                    project && name !== DEFAULT_PROJECT_NAME
                      ? { kind: "project", name, path: project.path }
                      : null,
                  );
                  setFolderPickerOpen(false);
                  setFolderSearch("");
                }}
                onPickDeviceFolder={(picked) => {
                  setFolder({ kind: "device", folder: picked });
                  setFolderPickerOpen(false);
                  setFolderSearch("");
                }}
              />
            </div>
            {/* At least as tall as the buttons beside it, with one line of text
                centered, so the text sits on their center line until it wraps.
                `--row-h` follows the buttons: `icon-sm`, raised to the touch
                floor where `touch-target` applies it. */}
            <div
              className="flex min-w-0 flex-1 items-center [--row-h:var(--control-h-sm)] [@media(hover:none)]:[--row-h:max(var(--control-h-sm),var(--rome-size-44,2.75rem))]"
              style={{ minHeight: "var(--row-h)" }}
            >
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
                  <textarea
                    ref={textareaRef}
                    value={inputText}
                    onChange={(event) => {
                      if (uploadInFlightRef.current) return;
                      setInputText(event.target.value);
                      reevaluateSlashContext(event.target.value, event.target.selectionEnd);
                    }}
                    onSelect={(event) => {
                      const el = event.currentTarget;
                      reevaluateSlashContext(el.value, el.selectionEnd);
                    }}
                    onInput={(event) => clampTextareaHeight(event.currentTarget)}
                    onKeyDown={(event) => {
                      if (handleSlashKeyDown(event)) return;
                      if (
                        event.key === "Escape" &&
                        (replyDraft?.target || replyDraft?.thread != null)
                      ) {
                        event.preventDefault();
                        replyDraft.clear();
                        return;
                      }
                      if (shouldSubmitOnEnter(event, { enterSends: !coarsePointer })) {
                        event.preventDefault();
                        void runSend();
                      }
                    }}
                    onPaste={(event) => {
                      const files = extractFilesFromClipboard(event.clipboardData);
                      if (files.length === 0) return;
                      event.preventDefault();
                      addPendingFiles(files);
                    }}
                    placeholder={
                      pendingUploads.length > 0
                        ? t("composer.placeholderWithUploads")
                        : replyDraft?.thread
                          ? t("thread.replyPlaceholder")
                          : (namedPlaceholder ?? t("concierge.placeholder"))
                    }
                    rows={1}
                    className="block w-full resize-none border-0 bg-transparent text-composer text-foreground placeholder:truncate placeholder:text-subtle-foreground focus:outline-none"
                    style={{
                      minHeight: "1lh",
                      maxHeight: `${TEXTAREA_MAX_HEIGHT}px`,
                    }}
                    disabled={uploadInFlight}
                    readOnly={voice.active}
                  />
                }
              />
            </div>
            {voice.available && !uploadInFlight ? (
              <VoiceInputButton state={voice.state} onToggle={voice.toggle} />
            ) : null}
            {isStreaming && onStop && (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onStop}
                title={t("composer.stopGenerating")}
                aria-label={t("composer.stopGenerating")}
                className="touch-target"
              >
                <span aria-hidden="true" className="inline-block size-2.5 bg-foreground" />
              </Button>
            )}
            {uploadInFlight ? (
              <Button
                variant="secondary"
                size="icon-sm"
                onClick={() => uploadAbortRef.current?.abort()}
                title={t("composer.cancelUpload")}
                aria-label={t("composer.cancelUpload")}
                className="touch-target"
              >
                <X aria-hidden />
              </Button>
            ) : (
              <Button
                variant={empty ? "secondary" : "default"}
                size="icon-sm"
                // Keep focus in the textarea, so a phone keeps its keyboard up
                // (see ChatComposer's Send for the full story).
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
                disabled={empty || voice.active}
                title={sendLabel}
                aria-label={sendLabel}
                className="touch-target"
              >
                <ArrowUp aria-hidden />
              </Button>
            )}
          </div>
        </form>
      </>
    );
  },
);
