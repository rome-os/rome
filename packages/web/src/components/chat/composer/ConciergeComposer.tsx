import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowUp, Cpu, MoreHorizontal, Paperclip, Plus, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { ErrorEventView } from "../entries/ErrorEventView";
import { ReplyBar } from "../reply/ReplyBar";
import { useReplyDraft } from "../reply/reply-draft";
import { PendingUploadsList } from "./PendingUploadsList";
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
  streamError?: string | ChatErrorNotice | null;
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
    { boxClassName, isStreaming = false, streamError, modelSelection, onSend },
    ref,
  ) {
    const { t } = useTranslation("chat");
    const replyDraft = useReplyDraft();
    const { data: settings } = useSettings();
    const coarsePointer = useCoarsePointer();
    const modelSelectorEnabled = settings?.enableModelSelector === true;
    // Turns carry the dashboard's reasoning effort, as in every other chat.
    const reasoningEffort = isReasoningEffort(settings?.webchatReasoningEffort)
      ? settings.webchatReasoningEffort
      : DEFAULT_REASONING_EFFORT;

    const [inputText, setInputText] = useState("");
    const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
    const [uploadInFlight, setUploadInFlight] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaFocusedAtPressRef = useRef(false);
    // The ref closes the same-event gap before React commits the state.
    const uploadInFlightRef = useRef(false);
    const uploadAbortRef = useRef<AbortController | null>(null);
    // The last failed send, so a retry of the same input reuses its inputId.
    const failedSendRef = useRef<{
      inputId: string;
      text: string;
      uploads: PendingUpload[];
    } | null>(null);

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
      ): ChatComposerSnapshot => ({
        text,
        uploads,
        reasoningEffort,
        // A session keeps its project; the field is only read for a draft.
        projectPath: DEFAULT_PROJECT_NAME,
        inputId,
        replyTo,
      }),
      [reasoningEffort],
    );

    const runSend = useCallback(async () => {
      if (uploadInFlightRef.current) return;
      const text = inputText.trim();
      const rawText = inputText;
      const uploads = pendingUploads;
      if (!text && uploads.length === 0) return;
      const failed = failedSendRef.current;
      const inputId =
        failed && failed.text === text && failed.uploads === uploads
          ? failed.inputId
          : randomUUID();
      // Text alone clears at once and comes back on failure. Attachments keep
      // the text on screen until the server accepts the upload.
      const clearsOptimistically = uploads.length === 0;
      const replyTo = replyDraft?.target ?? undefined;
      if (clearsOptimistically) {
        setInputText("");
        setPendingUploads([]);
        replyDraft?.clear();
      }
      try {
        await invokeOnSend(snapshotOf(text, uploads, inputId, replyTo));
        failedSendRef.current = null;
        if (!clearsOptimistically) {
          replyDraft?.clear();
          const sentIds = new Set(uploads.map((upload) => upload.id));
          setPendingUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
          setInputText((current) => (current === rawText ? "" : current));
        }
      } catch {
        failedSendRef.current = { inputId, text, uploads };
        if (clearsOptimistically) {
          setInputText(text);
          setPendingUploads(uploads);
          if (replyTo) replyDraft?.restore(replyTo);
        }
      }
    }, [inputText, pendingUploads, invokeOnSend, snapshotOf, replyDraft]);

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
        // Concierge has no skills.
        setSkillSelection: () => {},
        addFiles: addPendingFiles,
        submit: (text) => {
          const trimmed = text.trim();
          if (uploadInFlightRef.current || (!trimmed && pendingUploads.length === 0)) return;
          const uploads = pendingUploads;
          void invokeOnSend(snapshotOf(trimmed, uploads))
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
      [addPendingFiles, pendingUploads, invokeOnSend, snapshotOf, reasoningEffort],
    );

    const empty = !inputText.trim() && pendingUploads.length === 0;
    const sendLabel = isStreaming ? t("composer.sendWhileRunningTitle") : t("composer.sendTitle");
    const showModel = !!modelSelection && modelSelectorEnabled;
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
        <div data-chat-composer-box className={cn("relative z-10", boxClassName)}>
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
          </div>
          <div className="flex items-end gap-2">
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
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-44">
                <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                  <Paperclip aria-hidden />
                  {t("composer.uploadFiles")}
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
                          {t("modelSelector.showAll", { count: LARGE_MODEL_OPTIONS.length })}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* At least as tall as the buttons beside it, with one line of text
                centered, so the text sits on their center line until it wraps.
                `--row-h` follows the buttons: `icon-sm`, raised to the touch
                floor where `touch-target` applies it. */}
            <div
              className="flex min-w-0 flex-1 items-center [--row-h:var(--control-h-sm)] [@media(hover:none)]:[--row-h:max(var(--control-h-sm),var(--rome-size-44,2.75rem))]"
              style={{ minHeight: "var(--row-h)" }}
            >
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                onInput={(event) => clampTextareaHeight(event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && replyDraft?.target) {
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
                    : t("concierge.placeholder")
                }
                rows={1}
                className="block w-full resize-none border-0 bg-transparent text-composer text-foreground placeholder:text-subtle-foreground focus:outline-none"
                style={{ minHeight: "1lh", maxHeight: `${TEXTAREA_MAX_HEIGHT}px` }}
                disabled={uploadInFlight}
              />
            </div>
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
                disabled={empty}
                title={sendLabel}
                aria-label={sendLabel}
                className="touch-target"
              >
                <ArrowUp aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </>
    );
  },
);
