import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import { randomUUID } from "@/lib/random-uuid";
import type { PendingUpload } from "@/lib/chat-types";

/** What a send that carries attachments reports back while it uploads. */
export interface AttachmentUploadControls {
  /** A fraction from 0 to 1, or `null` when the browser cannot size the body. */
  onUploadProgress: (progress: number | null) => void;
  /** Aborted when the guardian cancels the upload. */
  signal: AbortSignal;
}

export interface PendingAttachments {
  /** The attachments waiting to go out with the next message. */
  uploads: PendingUpload[];
  /** True while a send carrying attachments is uploading. */
  inFlight: boolean;
  /** The upload's progress from 0 to 1, `null` when unknown. Only meaningful while `inFlight`. */
  progress: number | null;
  /**
   * Turns true in the same event that starts the upload, before React commits
   * `inFlight`, so a second keypress in that event is already refused.
   */
  inFlightRef: RefObject<boolean>;
  /** Adds files to the tray. Ignored while an upload is in flight. */
  add: (files: File[]) => void;
  /** Removes one attachment. Ignored while an upload is in flight. */
  remove: (id: string) => void;
  /** Replaces the whole tray, as a send's clear and its restore on failure do. */
  set: (uploads: PendingUpload[]) => void;
  /** Removes the attachments that went out, keeping any added since. */
  removeSent: (sent: PendingUpload[]) => void;
  /**
   * Runs one send. When `uploads` is not empty, the tray is in flight until
   * `send` settles, `progress` follows its reports and `cancel` aborts its
   * signal. A send without attachments leaves every field untouched.
   */
  track: (
    uploads: PendingUpload[],
    send: (controls: AttachmentUploadControls) => void | Promise<void>,
  ) => Promise<void>;
  /** Aborts the upload in flight, if any. */
  cancel: () => void;
}

/** The attachments a chat composer holds for its next message, with upload progress and cancel. */
export function usePendingAttachments(): PendingAttachments {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [inFlight, setInFlight] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const inFlightRef = useRef(false);
  // Live for exactly one upload; `cancel` aborts through it.
  const abortRef = useRef<AbortController | null>(null);

  // The visible file picker is disabled during an upload, but paste and the
  // parent drop zones enter here directly. Refusing them keeps every file in
  // the tray part of the request whose progress the tray shows.
  const add = useCallback((files: File[]) => {
    if (files.length === 0 || inFlightRef.current) return;
    setUploads((prev) => [...prev, ...files.map((file) => ({ id: randomUUID(), file }))]);
  }, []);

  const remove = useCallback((id: string) => {
    if (inFlightRef.current) return;
    setUploads((prev) => prev.filter((upload) => upload.id !== id));
  }, []);

  const removeSent = useCallback((sent: PendingUpload[]) => {
    const sentIds = new Set(sent.map((upload) => upload.id));
    setUploads((current) => current.filter((upload) => !sentIds.has(upload.id)));
  }, []);

  const track = useCallback(
    async (
      sending: PendingUpload[],
      send: (controls: AttachmentUploadControls) => void | Promise<void>,
    ) => {
      const tracksUpload = sending.length > 0;
      const controller = new AbortController();
      if (tracksUpload) {
        inFlightRef.current = true;
        abortRef.current = controller;
        setInFlight(true);
        setProgress(0);
      }
      try {
        await send({
          onUploadProgress: (next) => {
            if (!tracksUpload) return;
            setProgress(next === null ? null : Math.max(0, Math.min(1, next)));
          },
          signal: controller.signal,
        });
      } finally {
        if (tracksUpload) {
          inFlightRef.current = false;
          abortRef.current = null;
          setInFlight(false);
          setProgress(null);
        }
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    uploads,
    inFlight,
    progress,
    inFlightRef,
    add,
    remove,
    set: setUploads,
    removeSent,
    track,
    cancel,
  };
}
