/**
 * Watches — and lightly drives — the raw PTY output of `claude /login` so a UI
 * can complete a Claude subscription login without making the user read a
 * terminal.
 *
 * The interactive first-run wizard may render first: a theme picker, then a
 * login-method picker. The watcher accepts those defaults when the terminal
 * shows "Dark mode" or "Claude account with subscription", then surfaces two
 * signals to the client: the OAuth `auth_url`, and a rejected-code `auth_error`
 * ("Invalid code …" — the CLI re-reads stdin for another code on its own, so a
 * rejected code needs no nudge).
 *
 * The first-run wizard is an Ink TUI, so its output differs from the old plain
 * `claude auth login` text: it colourises, positions words with cursor escapes
 * instead of spaces — cursor-forward (CUF) historically, with column-absolute
 * (CHA) joining it in CLI 2.1.251, and one stream can carry both — and may
 * print the sign-in URL either as an OSC-8 hyperlink or as a wrapped plain
 * URL. `stripAnsi` therefore turns CUF and CHA into a space (so glued words
 * separate for text matching) and drops the OSC/CSI noise; the URL parser
 * first tries the OSC-8 target and then rebuilds the wrapped plain URL from
 * its physical terminal lines.
 *
 * Deliberately fail-open: a parser miss (CLI reword) emits nothing and sends no
 * key, so the flow degrades to the modal's "sign-in URL never arrived" timeout
 * rather than doing the wrong thing. The matchers favour stable anchors over
 * completeness.
 */

export type ClaudeLoginEvent =
  | { type: "auth_url"; url: string }
  | { type: "auth_error"; message: string };

// Strip the escape soup the Ink TUI emits so plain text can be matched. Order
// matters: OSC first (hyperlinks/window titles), then CUF/CHA→space (so
// cursor-positioned words don't glue together), then the remaining CSI and
// two-char escapes, then any stray ESC. Each branch is anchored on ESC (\x1b),
// so URL/text characters survive.
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC … terminated by BEL or ST
    .replace(/\x1b\[[0-9]*[CG]/g, " ") // CUF / CHA (cursor positioning) → single space
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "") // other CSI sequences
    .replace(/\x1b[@-Z\\-_=>78]/g, "") // two-char (Fe/Fs) escapes, incl. DECSC/DECRC
    .replace(/\x1b/g, ""); // any stray ESC left over
}

// The subscription OAuth URL, served from the `/cai/` consumer-auth path.
const AUTH_URL_PREFIX = "https://claude.com/cai/oauth/authorize?";

// OSC-8 hyperlink: ESC ] 8 ; params ; <url> BEL/ST. When present, the target is
// the only representation guaranteed to be unwrapped.
const OSC_AUTH_URL = new RegExp(
  `\\x1b\\]8;[^\\x07\\x1b;]*;(${AUTH_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\x07\\x1b]+)(?:\\x07|\\x1b\\\\)`,
);

// Characters permitted inside an OAuth URL. Newlines are intentionally excluded:
// the plain TUI variant wraps long URLs across terminal rows, and
// `extractPlainAuthUrl` decides which line breaks are soft wraps.
const URL_CHAR = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]$/;

// A rejected pasted code. The CLI usually prints "OAuth error: Invalid code…",
// but some malformed inputs (notably non-bracketed codes containing `#`) print
// "OAuth error: Request failed with status code 400" instead. Capture from the
// stable error phrase to the line end so the client can show the CLI's wording.
const AUTH_ERROR = /(?:Invalid code|Request failed with status code \d+)[^\r\n]*/gi;

// First-run wizard screens the watcher auto-advances with Enter, which accepts
// each screen's default: any theme, and "Claude account with subscription" —
// the Claude AI (subscription) login, which the CLI lists first.
const THEME_PROMPT = /(?:Choose the text style|Dark mode)/i;
const LOGIN_PROMPT = /(?:Select login method|Claude account with subscription)/i;
const PASTE_CODE_PROMPT = /Paste\s+code\s+here/i;
const ENTER = "\r";
const AUTO_ENTER_RETRY_MS = 1_500;
const MAX_AUTO_ENTER_ATTEMPTS_PER_PROMPT = 8;

// The login output is small; this cap only guards against an unbounded stream
// that never matches. It comfortably exceeds one OAuth URL.
const MAX_BUFFER = 256 * 1024;
const PROMPT_TAIL_LENGTH = 8 * 1024;

type AutoPrompt = "theme" | "login";

function isUrlChar(ch: string): boolean {
  return URL_CHAR.test(ch);
}

function leadingUrlRun(line: string): string {
  let end = 0;
  while (end < line.length && isUrlChar(line[end])) {
    end++;
  }
  return line.slice(0, end);
}

function isCompleteAuthUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      url.hostname === "claude.com" &&
      url.pathname === "/cai/oauth/authorize" &&
      url.searchParams.has("client_id") &&
      url.searchParams.has("state")
    );
  } catch {
    return false;
  }
}

function extractOscAuthUrl(raw: string): string | null {
  const match = raw.match(OSC_AUTH_URL);
  const candidate = match?.[1];
  return candidate && isCompleteAuthUrl(candidate) ? candidate : null;
}

function extractPlainAuthUrl(text: string): string | null {
  const start = text.indexOf(AUTH_URL_PREFIX);
  if (start === -1) return null;

  // The TUI often emits CRCRLF for a rendered line ending. Collapse that to one
  // logical line break while preserving true blank lines as "\n\n" terminators.
  const lines = text.slice(start).replace(/\r+\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let candidate = "";
  let sawTerminator = false;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    if (line === "") {
      // A blank line after any URL characters means the URL block is complete.
      // If it is a trailing newline after a complete single-line URL, that is
      // also safe to treat as complete; incomplete wrapped URLs fail validation.
      if (candidate) sawTerminator = true;
      break;
    }

    const run = leadingUrlRun(line);
    if (!run) {
      if (candidate) sawTerminator = true;
      break;
    }

    // Continuation lines must be pure URL characters. A prompt like "Paste code
    // here" begins with URL-legal letters, but the following space proves it is
    // not part of the wrapped URL.
    if (candidate && run.length < line.length) {
      sawTerminator = true;
      break;
    }

    candidate += run;

    // If the line contains non-URL text after the URL run, the URL ended on this
    // line. This covers the old plain `claude auth login` shape.
    if (run.length < line.length) {
      sawTerminator = true;
      break;
    }

    // If this is the last physical line we have, wait for more PTY output before
    // emitting; otherwise a wrapped URL split across chunks would open a
    // truncated page.
    if (index === lines.length - 1) {
      break;
    }
  }

  return sawTerminator && isCompleteAuthUrl(candidate) ? candidate : null;
}

function extractAuthUrl(raw: string, text: string): string | null {
  return extractOscAuthUrl(raw) ?? extractPlainAuthUrl(text);
}

export interface ClaudeLoginWatcher {
  push(chunk: string): void;
  dispose(): void;
}

/**
 * @param emit surface a parsed login event to the client
 * @param send write keystrokes back to the PTY to auto-advance the first-run
 *   wizard; omit (e.g. in parse-only tests) to disable auto-driving
 */
export function createClaudeLoginWatcher(
  emit: (event: ClaudeLoginEvent) => void,
  send?: (data: string) => void,
): ClaudeLoginWatcher {
  // Keep the raw bytes and re-strip the whole buffer on each push: cheap for the
  // small login stream, and it transparently recovers escape sequences (and the
  // URL) split across PTY chunks without per-chunk bookkeeping.
  let raw = "";
  let urlEmitted = false;
  let errorsEmitted = 0;
  let latestText = "";
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryPrompt: AutoPrompt | null = null;
  let disposed = false;
  const attempts: Record<AutoPrompt, number> = { theme: 0, login: 0 };

  function visiblePrompt(): AutoPrompt | null {
    if (urlEmitted) return null;

    // Work from the tail instead of the whole accumulated buffer. Once the login
    // method screen appears, the earlier theme text can still be present in the
    // raw PTY history; the tail best approximates the current Ink screen without
    // building a full terminal emulator.
    const tail = latestText.slice(-PROMPT_TAIL_LENGTH);
    const rawTail = raw.slice(-PROMPT_TAIL_LENGTH);
    if (
      PASTE_CODE_PROMPT.test(tail) ||
      tail.includes(AUTH_URL_PREFIX) ||
      rawTail.includes(AUTH_URL_PREFIX)
    ) {
      return null;
    }
    if (LOGIN_PROMPT.test(tail)) return "login";
    if (THEME_PROMPT.test(tail)) return "theme";
    return null;
  }

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryPrompt = null;
  }

  function scheduleRetry(prompt: AutoPrompt): void {
    if (disposed) return;
    if (retryTimer !== null && retryPrompt === prompt) return;
    clearRetryTimer();
    retryPrompt = prompt;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryPrompt = null;
      advanceVisiblePrompt();
    }, AUTO_ENTER_RETRY_MS);
  }

  function advanceVisiblePrompt(): void {
    if (!send || disposed) return;

    const prompt = visiblePrompt();
    if (!prompt) {
      clearRetryTimer();
      return;
    }
    if (retryTimer !== null && retryPrompt === prompt) {
      return;
    }

    if (attempts[prompt] >= MAX_AUTO_ENTER_ATTEMPTS_PER_PROMPT) {
      clearRetryTimer();
      return;
    }

    attempts[prompt]++;
    send(ENTER);
    scheduleRetry(prompt);
  }

  return {
    push(chunk: string): void {
      if (disposed) return;

      raw += chunk;
      if (raw.length > MAX_BUFFER) {
        raw = raw.slice(-MAX_BUFFER);
      }
      latestText = stripAnsi(raw);

      if (!urlEmitted) {
        const url = extractAuthUrl(raw, latestText);
        if (url) {
          urlEmitted = true;
          clearRetryTimer();
          emit({ type: "auth_url", url });
        }
      }

      // Auto-advance the first-run wizard. Each screen pre-selects the option we
      // want, so Enter is safe; if the Enter is dropped and the same picker stays
      // visible, a scheduled retry nudges it again even if the TUI is otherwise
      // idle.
      advanceVisiblePrompt();

      // Each rejected code prints a fresh "Invalid code" line; emit only the
      // ones not seen yet so a re-paste after a typo isn't swallowed.
      const errors = latestText.match(AUTH_ERROR) ?? [];
      for (; errorsEmitted < errors.length; errorsEmitted++) {
        emit({ type: "auth_error", message: errors[errorsEmitted].trim() });
      }
    },
    dispose(): void {
      disposed = true;
      clearRetryTimer();
    },
  };
}
