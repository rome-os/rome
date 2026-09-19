import type { ChatMessage } from "./chat-types";

export const MAX_TRANSCRIPT_CACHE_ENTRIES = 5;
export const MAX_TRANSCRIPT_CACHE_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_CACHE_ENTRY_BYTES = 10 * 1024 * 1024;

interface TranscriptCacheEntry {
  messages: ChatMessage[];
  messageSizes: Map<string, number>;
  size: number;
  lastViewed: number;
}

export interface TranscriptRequestToken {
  readonly contextKey: string | null;
  readonly sessionId: string;
  readonly revision: number;
  readonly contextRevision: number;
}

export interface TranscriptSessionToken {
  readonly contextKey: string | null;
  readonly sessionId: string;
  readonly contextRevision: number;
}

export interface TranscriptAuthorizationRevocation {
  readonly contextKey: string;
  readonly contextRevision: number;
}

const textEncoder = new TextEncoder();

function estimateMessageSize(message: ChatMessage): number {
  return textEncoder.encode(JSON.stringify(message)).byteLength;
}

function measureTranscript(messages: ChatMessage[]): {
  messageSizes: Map<string, number>;
  size: number;
} {
  const messageSizes = new Map<string, number>();
  let size = 2; // JSON array brackets.
  for (const [index, message] of messages.entries()) {
    const messageSize = estimateMessageSize(message);
    messageSizes.set(message.id, messageSize);
    size += messageSize + (index === 0 ? 0 : 1); // Array comma.
  }
  return { messageSizes, size };
}

export class ChatTranscriptCache {
  private contextKey: string | null = null;
  private entries = new Map<string, TranscriptCacheEntry>();
  private protectedSessions = new Map<string, Set<symbol>>();
  private latestRequests = new Map<string, number>();
  private activeRequests = new Map<string, Set<number>>();
  private authorizationRevoked = false;
  private authorizationRevocationListeners = new Set<
    (revocation: TranscriptAuthorizationRevocation) => void
  >();
  private clock = 0;
  private requestClock = 0;
  private contextRevision = 0;

  activateContext(contextKey: string | null): void {
    if (contextKey === this.contextKey) return;
    // The initial null context means dashboard identity is still resolving.
    // Preserve in-flight ownership through that one-way activation so a cold
    // request can populate the now-authenticated cache without being repeated.
    // Every transition away from a concrete identity is a security boundary.
    const resolvingInitialIdentity = this.contextKey === null && contextKey !== null;
    if (resolvingInitialIdentity) {
      this.entries.clear();
      this.protectedSessions.clear();
    } else {
      this.clear();
      this.contextRevision += 1;
    }
    this.contextKey = contextKey;
  }

  clear(): void {
    this.entries.clear();
    this.protectedSessions.clear();
    this.latestRequests.clear();
    this.activeRequests.clear();
    this.authorizationRevoked = false;
  }

  isContextActive(contextKey: string | null): boolean {
    return contextKey !== null && contextKey === this.contextKey && !this.authorizationRevoked;
  }

  get(contextKey: string | null, sessionId: string): ChatMessage[] | undefined {
    if (!contextKey || contextKey !== this.contextKey || this.authorizationRevoked)
      return undefined;
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    entry.lastViewed = ++this.clock;
    return entry.messages;
  }

  putComplete(contextKey: string | null, sessionId: string, messages: ChatMessage[]): boolean {
    if (!contextKey || contextKey !== this.contextKey || this.authorizationRevoked) return false;

    const { messageSizes, size } = measureTranscript(messages);
    if (size > MAX_TRANSCRIPT_CACHE_ENTRY_BYTES) {
      this.entries.delete(sessionId);
      return false;
    }

    const previous = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      messages,
      messageSizes,
      size,
      lastViewed: previous?.lastViewed ?? ++this.clock,
    });

    if (!this.enforceLimits(sessionId)) {
      if (previous) this.entries.set(sessionId, previous);
      else this.entries.delete(sessionId);
      return false;
    }
    return true;
  }

  upsertMessageIfPresent(
    contextKey: string | null,
    sessionId: string,
    message: ChatMessage,
    update: (messages: ChatMessage[]) => ChatMessage[],
  ): void {
    if (!contextKey || contextKey !== this.contextKey || this.authorizationRevoked) return;
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    // Live SSE inserts are the hot path. Account for only the inserted or
    // replaced message instead of serializing the entire transcript on every
    // event, while retaining the exact byte size of the JSON array.
    const previousMessageSize = entry.messageSizes.get(message.id);
    const messageSize = estimateMessageSize(message);
    const size =
      previousMessageSize === undefined
        ? entry.size + messageSize + (entry.messages.length === 0 ? 0 : 1)
        : entry.size - previousMessageSize + messageSize;

    if (size > MAX_TRANSCRIPT_CACHE_ENTRY_BYTES) {
      this.entries.delete(sessionId);
      return;
    }

    const messageSizes = new Map(entry.messageSizes);
    messageSizes.set(message.id, messageSize);
    this.entries.set(sessionId, {
      messages: update(entry.messages),
      messageSizes,
      size,
      lastViewed: entry.lastViewed,
    });
    // An updated transcript must not survive above either byte budget. Other
    // inactive entries may be evicted first; if protected entries leave no
    // room, drop this candidate rather than retaining stale accounting.
    if (!this.enforceLimits(sessionId)) this.entries.delete(sessionId);
  }

  delete(contextKey: string | null, sessionId: string): void {
    if (!contextKey || contextKey !== this.contextKey) return;
    this.entries.delete(sessionId);
    this.latestRequests.delete(sessionId);
    this.activeRequests.delete(sessionId);
  }

  revokeAuthorization(contextKey: string | null): boolean {
    if (!contextKey || contextKey !== this.contextKey) return false;
    this.entries.clear();
    this.protectedSessions.clear();
    this.latestRequests.clear();
    this.activeRequests.clear();
    this.authorizationRevoked = true;
    this.contextRevision += 1;
    const revocation = {
      contextKey,
      contextRevision: this.contextRevision,
    };
    for (const listener of [...this.authorizationRevocationListeners]) listener(revocation);
    return true;
  }

  subscribeAuthorizationRevocations(
    listener: (revocation: TranscriptAuthorizationRevocation) => void,
  ): () => void {
    this.authorizationRevocationListeners.add(listener);
    return () => this.authorizationRevocationListeners.delete(listener);
  }

  isAuthorizationRevoked(contextKey: string | null): boolean {
    return contextKey !== null && contextKey === this.contextKey && this.authorizationRevoked;
  }

  captureSession(contextKey: string | null, sessionId: string): TranscriptSessionToken {
    if (contextKey !== this.contextKey || (contextKey !== null && this.authorizationRevoked)) {
      return { contextKey, sessionId, contextRevision: -1 };
    }
    return {
      contextKey,
      sessionId,
      contextRevision: this.contextRevision,
    };
  }

  isSessionCurrent(token: TranscriptSessionToken, contextKey: string | null): boolean {
    // Chats outside the authenticated dashboard cache boundary still use the
    // shared component. They have no cache context to revoke; keep their local
    // request/event ownership working even if another mounted boundary has an
    // active authenticated cache.
    if (token.contextRevision === -1) {
      return token.contextKey === null && contextKey === null;
    }
    if (!this.isTokenContextCurrent(token, contextKey)) return false;
    return true;
  }

  protect(contextKey: string | null, sessionId: string, owner: symbol): void {
    if (!contextKey || contextKey !== this.contextKey || this.authorizationRevoked) return;
    const owners = this.protectedSessions.get(sessionId) ?? new Set<symbol>();
    owners.add(owner);
    this.protectedSessions.set(sessionId, owners);
    const entry = this.entries.get(sessionId);
    if (entry) entry.lastViewed = ++this.clock;
  }

  unprotect(contextKey: string | null, sessionId: string, owner: symbol): void {
    if (!contextKey || contextKey !== this.contextKey) return;
    const owners = this.protectedSessions.get(sessionId);
    owners?.delete(owner);
    if (owners?.size === 0) this.protectedSessions.delete(sessionId);
  }

  beginRequest(contextKey: string | null, sessionId: string): TranscriptRequestToken {
    const revision = ++this.requestClock;
    if (contextKey !== this.contextKey || (contextKey !== null && this.authorizationRevoked)) {
      return {
        contextKey,
        sessionId,
        revision,
        contextRevision: -1,
      };
    }
    const active = this.activeRequests.get(sessionId) ?? new Set<number>();
    active.add(revision);
    this.activeRequests.set(sessionId, active);
    this.latestRequests.set(sessionId, revision);
    return {
      contextKey,
      sessionId,
      revision,
      contextRevision: this.contextRevision,
    };
  }

  canWriteComplete(token: TranscriptRequestToken, contextKey: string | null): boolean {
    if (!contextKey || contextKey !== this.contextKey || this.authorizationRevoked) return false;
    if (token.contextRevision !== this.contextRevision) return false;
    if (this.latestRequests.get(token.sessionId) === token.revision) return true;
    // A complete older response is a valid fallback while its newer
    // replacement is still pending. It may populate the cache now; a
    // successful newer response will replace it, while a completed newer
    // response prevents this branch and cannot be overwritten later.
    return [...(this.activeRequests.get(token.sessionId) ?? [])].some(
      (revision) => revision > token.revision,
    );
  }

  isRequestContextCurrent(token: TranscriptRequestToken, contextKey: string | null): boolean {
    return this.isSessionCurrent(token, contextKey);
  }

  finishRequest(token: TranscriptRequestToken, options: { failed?: boolean } = {}): void {
    const active = this.activeRequests.get(token.sessionId);
    active?.delete(token.revision);
    if (active?.size === 0) this.activeRequests.delete(token.sessionId);

    if (this.latestRequests.get(token.sessionId) !== token.revision) return;
    if (options.failed && active?.size) {
      this.latestRequests.set(token.sessionId, Math.max(...active));
      return;
    }
    this.latestRequests.delete(token.sessionId);
  }

  snapshot(): { ids: string[]; totalBytes: number } {
    return {
      ids: [...this.entries.entries()]
        .sort((a, b) => a[1].lastViewed - b[1].lastViewed)
        .map(([id]) => id),
      totalBytes: this.totalBytes(),
    };
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    return total;
  }

  private isTokenContextCurrent(
    token: Pick<TranscriptSessionToken, "contextKey" | "contextRevision">,
    contextKey: string | null,
  ): boolean {
    if (token.contextRevision !== this.contextRevision) return false;
    if (contextKey === this.contextKey) return true;
    // The boundary activates the first authenticated context before publishing
    // it to children. Work started while identity was pending may finish in
    // that narrow interval; it still belongs to this unchanged revision.
    return token.contextKey === null && contextKey === null && this.contextKey !== null;
  }

  private enforceLimits(candidateSessionId: string): boolean {
    let entryCount = this.entries.size;
    let totalBytes = this.totalBytes();
    const victims: string[] = [];
    const candidates = [...this.entries.entries()]
      .filter(
        ([sessionId]) => sessionId !== candidateSessionId && !this.protectedSessions.has(sessionId),
      )
      .sort((a, b) => a[1].lastViewed - b[1].lastViewed);

    for (const [sessionId, entry] of candidates) {
      if (entryCount <= MAX_TRANSCRIPT_CACHE_ENTRIES && totalBytes <= MAX_TRANSCRIPT_CACHE_BYTES) {
        break;
      }
      victims.push(sessionId);
      entryCount -= 1;
      totalBytes -= entry.size;
    }

    if (entryCount > MAX_TRANSCRIPT_CACHE_ENTRIES || totalBytes > MAX_TRANSCRIPT_CACHE_BYTES) {
      return false;
    }
    for (const sessionId of victims) this.entries.delete(sessionId);
    return true;
  }
}

export const chatTranscriptCache = new ChatTranscriptCache();
