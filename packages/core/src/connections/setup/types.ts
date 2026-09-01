// Connection conferral setup contracts. Messaging model: docs/concepts/messaging.md.
//
// A setup is a server-owned coroutine that walks a guardian through
// connecting one grant of one service. Builders write linear async code
// (`setup(interact, ctx)`) suspended at interaction points; the runtime pumps
// the coroutine and clients poll the resulting state. The verb set is
// deliberately closed — `prompt` (blocking input), `show` (non-blocking
// presentation), `redirect` (blocking hand-off out and back) — and every
// external-event await flows through `ctx.step` so cancellation can genuinely
// interrupt an in-flight wait and (later) journal replay can resurrect a
// setup across restarts.
//
// Content payloads are the HARD RULE: they are semantically complete
// (copy authored server-side, next to the setup), so any surface — the
// dashboard, a chat-driven conferral — can narrate any setup from the payload
// alone. Custom per-`(service, state)` components override RENDERING only.

import type { Credential, ProfileRecord } from "../types.js";

/**
 * One field the guardian fills in a `prompt`. Structurally identical to the
 * `GuardianInteraction.prompt` field shape so an `AuthScheme`
 * form maps straight onto a setup form.
 */
export interface SetupFormField {
  /** The answer key this field lands under in the returned record. */
  name: string;
  label: string;
  /** Credentials default to secret; a plain identifier passes `secret: false`. */
  secret: boolean;
  format?: "line" | "multiline" | "file";
  /** Presented as a select when set. */
  options?: string[];
}

/** A labeled external link inside a view (e.g. "Open the Developer Portal"). */
export interface SetupViewLink {
  label: string;
  url: string;
}

/** One step in a view's checklist. `done` marks completed steps for progress
 *  views; omit it for plain instructions. */
export interface SetupViewStep {
  text: string;
  done?: boolean;
}

/** A prompt's form — the instructional preamble plus the fields to collect. The
 *  preamble mirrors {@link SetupView}'s narrative slots (`steps`, `links`) so a
 *  token-paste prompt can carry a full "how to get this credential" guide
 *  (create the bot, copy the token) next to the field — the standard renderer
 *  shows the numbered steps and links above the inputs. */
export interface SetupForm {
  instructions?: string;
  /** A numbered how-to shown above the fields (e.g. the BotFather walkthrough). */
  steps?: SetupViewStep[];
  /** Labeled external links shown with the guide (e.g. @BotFather, the Portal). */
  links?: SetupViewLink[];
  fields: SetupFormField[];
  /** A closing aside shown below the fields (e.g. a troubleshooting note). */
  note?: string;
}

/**
 * The capped content schema for a presented view. Deliberately small: a title,
 * paragraphs of structured text, labeled links, and a step checklist. Anything
 * richer justifies a custom renderer rather than widening this schema.
 * `progress: true` flags a view the standard renderer shows in its
 * progress/working flavor (rendered while the coroutine awaits an external
 * event inside `ctx.step`).
 */
export interface SetupView {
  title?: string;
  /** Paragraphs of plain structured text. */
  body?: string[];
  links?: SetupViewLink[];
  steps?: SetupViewStep[];
  /** A QR code for the guardian to scan, as a `data:` image URL. First-class
   *  because QR conferral recurs across services (WeChat, WhatsApp): the server
   *  renders the image once and every surface — dashboard `<img>`, a chat
   *  message — presents it without its own QR encoder. The raw content string
   *  rides along in `links` so a surface that prefers a tappable link has it. */
  qr?: string;
  /** True for the working/progress flavor of the standard renderer. */
  progress?: boolean;
}

/**
 * The one durable outcome a setup coroutine returns — the terminal
 * conferral. The runtime performs a SINGLE ledger write from it (credential +
 * profile), plus an optional guardian channel mapping, only once the coroutine
 * returns; nothing half-conferred is ever observable. Abandoning or cancelling a
 * setup runs no write at all.
 */
export interface SetupConferral {
  /** The proven credential for this grant. */
  credential: Credential;
  /** The non-secret conferral outcome written in the same update as the
   *  credential. Omit when there is no identity to record. */
  profile?: ProfileRecord;
  /** The guardian's own identity on this service's channel to auto-map in the
   *  same terminal write (e.g. Discord's verified author id). Omit for services
   *  with no guardian-link step. */
  guardianChannelUserId?: string;
  /** The success view the standard "done" renderer presents. */
  summary?: SetupView;
}

/**
 * The poll-able setup state — exactly what `GET /api/setups/:cid`
 * returns. `presenting` is both the `show` result AND the snapshot rendered
 * while the coroutine awaits an external event inside `ctx.step` (the last
 * shown view, or a default working view).
 */
export type SetupState =
  | { status: "awaiting-input"; form: SetupForm; error?: string }
  | { status: "awaiting-redirect"; url: string }
  | { status: "presenting"; view: SetupView }
  | { status: "done"; conferral: SetupDoneView }
  | { status: "failed"; reason: string }
  | { status: "cancelled" };

/** The client-visible half of a terminal conferral — the summary view only.
 *  The credential and raw profile never cross to the client. */
export interface SetupDoneView {
  summary?: SetupView;
}

/** The guardian-facing verbs handed to a setup coroutine. Deliberately
 *  closed: no `poll`, no RPC. */
export interface SetupInteraction {
  /**
   * Blocking: present a form and resolve with the guardian's answers. Re-prompt
   * by calling `prompt` again with an `error` — the runtime re-renders the same
   * form carrying the error until the guardian submits acceptable input.
   */
  prompt(form: SetupForm & { error?: string }): Promise<Record<string, string>>;
  /** Non-blocking: present a view. The coroutine continues immediately; the view
   *  becomes the snapshot rendered during subsequent `ctx.step` waits. */
  show(view: SetupView): void;
  /**
   * Blocking: hand the guardian off to an external URL and resolve with the
   * return-leg payload once they come back (the OAuth round-trip). Not used by
   * the Discord pilot; part of the closed verb set for the OAuth cutover.
   */
  redirect(url: string): Promise<Record<string, string>>;
}

/** The runtime context handed to a setup coroutine alongside the verbs. */
export interface SetupContext {
  /**
   * Wrap EVERY external-event await. `label` is the future journal key;
   * `signal` is mandatory so builders cannot write an un-cancellable wait. The
   * runtime both passes the signal to `fn` AND races the abort itself, so a
   * `fn` that ignores its signal is still interrupted on cancel
   * (defense-in-depth).
   */
  step<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** The setup's cancellation signal — aborts when the guardian cancels. */
  readonly signal: AbortSignal;
}

/**
 * A builder-written setup coroutine. Linear async code that suspends at the
 * verbs and returns its terminal conferral. Lives on the integration descriptor
 * next to the grant it confers.
 */
export type SetupFn = (interact: SetupInteraction, ctx: SetupContext) => Promise<SetupConferral>;
