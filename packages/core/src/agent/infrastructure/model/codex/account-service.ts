import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../../../logger.js";
import {
  getCodexCliStatus,
  markCodexAuthRevoked,
  type CodexCliStatus,
  type CodexPlanType,
} from "../../../../lib/codex-cli-auth.js";
import {
  getErrorMessage,
  normalizeUsageStatus,
  readLiveOrCachedUsage,
  type AIToolUsageStatus,
} from "../../../../lib/provider-usage.js";
import type {
  ModelAccount,
  ModelAccountAuthorization,
  ModelAccountStatus,
  ModelAuthorizationMode,
  ModelAuthorizationState,
  ModelBrowserAuthorization,
  ModelDeviceAuthorization,
} from "../../../domain/model-account.js";
import { CODEX_LUNA_MODEL, CODEX_SOL_MODEL } from "../../../domain/model-selection.js";
import type { ProviderAvailability } from "../../../domain/provider-availability.js";
import { accountAvailability, usageShowsCapacity } from "../account-availability.js";
import {
  type LearnsRefusedTurns,
  type RefusedTurn,
  type UsageRefusal,
  usageReadClearsRefusal,
  usageRefusalAt,
  usageRefusalEnded,
} from "../refused-turn.js";
import { isCodexAuthRevokedError } from "./auth-revoked.js";
import { Method, Notify } from "./app-server-protocol.js";
import type {
  CodexAppServerExitListener,
  CodexAppServerManager,
  CodexAppServerNotificationListener,
} from "./app-server-manager.js";

const log = createLogger("codex-account-service");

const CODEX_USAGE_CACHE_PATHS = ["usage-limits.json", "rate-limits.json"].map((file) =>
  join(homedir(), ".codex", file),
);
const DEFAULT_LOGIN_TIMEOUT_MS = 16 * 60 * 1000;

interface ActiveLogin {
  loginId: string;
  mode: ModelAuthorizationMode;
  userCode: string | null;
  verificationUrl: string | null;
  timeout: ReturnType<typeof setTimeout>;
}

interface CodexAccountReadResponse {
  account: unknown;
  requiresOpenaiAuth: boolean;
}

interface BrowserLoginResponse {
  type?: string;
  loginId?: unknown;
  authUrl?: unknown;
}

interface DeviceLoginResponse {
  type?: string;
  loginId?: unknown;
  userCode?: unknown;
  verificationUrl?: unknown;
}

interface LoginCompletedNotification {
  loginId?: unknown;
  success?: unknown;
  error?: unknown;
}

interface CodexAccountRpc {
  request<T>(method: string, params?: unknown): Promise<T>;
  onNotification(method: string, listener: CodexAppServerNotificationListener): () => void;
  onExit(listener: CodexAppServerExitListener): () => void;
}

export interface SharedCodexAccountServiceOptions {
  loginTimeoutMs?: number;
  usageCachePaths?: string[];
  readFileStatus?: () => Promise<CodexCliStatus>;
  markAuthRevoked?: () => Promise<void>;
  now?: () => number;
}

function statusFromFile(fileStatus: CodexCliStatus): ModelAccountStatus {
  return {
    loggedIn: fileStatus.loggedIn,
    authMode: fileStatus.authMode,
    planType: fileStatus.planType,
    accountType: fileStatus.accountType,
    email: fileStatus.email,
    needsReauth: fileStatus.needsReauth,
  };
}

/** The ChatGPT plans that serve every Codex model. The others do not serve the frontier models below. */
const FULL_MODEL_ACCESS_PLANS = new Set<CodexPlanType>([
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
]);

/** The frontier models a restricted plan does not serve: the Sol, Luna and Astra family. */
export const RESTRICTED_PLAN_DENIED_MODELS: readonly string[] = [
  "gpt-6-astra",
  CODEX_SOL_MODEL,
  "gpt-6-sol",
  "gpt-5.6-sol",
  CODEX_LUNA_MODEL,
  "gpt-5.6-luna",
];

/** What the account's plan withholds and whether the provider limits its usage. */
function planFacts(
  status: ModelAccountStatus,
): Pick<ModelAccountStatus, "modelsDenied" | "usageLimited"> {
  if (!status.loggedIn) return {};
  if (status.authMode === "apikey") return { usageLimited: false };
  const full = status.planType !== undefined && FULL_MODEL_ACCESS_PLANS.has(status.planType);
  return { usageLimited: true, ...(full ? {} : { modelsDenied: RESTRICTED_PLAN_DENIED_MODELS }) };
}

function rateLimitsPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.result) return rateLimitsPayload(record.result);
  const byLimitId = record.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === "object") {
    const codex = (byLimitId as Record<string, unknown>).codex;
    if (codex) return codex;
  }
  return record.rateLimits ?? value;
}

export class SharedCodexAccountService
  implements ModelAccount, ModelAccountAuthorization, LearnsRefusedTurns
{
  private readonly manager: CodexAccountRpc;
  private readonly loginTimeoutMs: number;
  private readonly usageCachePaths: string[];
  private readonly readFileStatus: () => Promise<CodexCliStatus>;
  private readonly markAuthRevoked: () => Promise<void>;
  private readonly accountChangedListeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void>;
  private activeLogin: ActiveLogin | null = null;
  private loginStartPending = false;
  private loginStartEpoch = 0;
  private cancelPendingLoginStart = false;
  private earlyLoginCompletion: LoginCompletedNotification | null = null;
  private lastLoginError: string | null = null;
  /** The usage refusal the adapter last saw, until a later usage read shows capacity. */
  private refusal: UsageRefusal | undefined;
  /** The last report, so a limit still ahead survives a usage read that fails. */
  private last: ProviderAvailability | undefined;
  private readonly now: () => number;
  private closed = false;

  constructor(
    manager: CodexAppServerManager | CodexAccountRpc,
    options: SharedCodexAccountServiceOptions = {},
  ) {
    this.manager = manager;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.usageCachePaths = options.usageCachePaths ?? CODEX_USAGE_CACHE_PATHS;
    this.readFileStatus = options.readFileStatus ?? getCodexCliStatus;
    this.markAuthRevoked = options.markAuthRevoked ?? markCodexAuthRevoked;
    this.now = options.now ?? Date.now;
    this.unsubscribers = [
      manager.onNotification(Notify.accountLoginCompleted, (params) => {
        this.handleLoginCompleted(params);
      }),
      manager.onNotification(Notify.accountUpdated, () => {
        this.emitAccountChanged();
      }),
      manager.onNotification(Notify.accountRateLimitsUpdated, () => {
        this.emitAccountChanged();
      }),
      manager.onExit((error) => {
        this.handleManagerExit(error);
      }),
    ];
  }

  /**
   * Reads the status and the usage together. A usage read that shows
   * capacity after the hold ends a refusal; one in the hold describes the
   * account before the refused turn.
   */
  async availability(): Promise<ProviderAvailability> {
    const readAt = this.now();
    const [status, usage] = await Promise.all([this.status(), this.usage()]);
    if (usage && usageShowsCapacity(usage) && this.refusal) {
      if (usageReadClearsRefusal(this.refusal, readAt)) this.refusal = undefined;
    }
    this.last = accountAvailability(status, usage, this.heldRefusal(), this.now(), this.last);
    return this.last;
  }

  async status(): Promise<ModelAccountStatus> {
    const read = await this.readStatus();
    return { ...read, ...planFacts(read) };
  }

  /** The refusal still held: one whose end has not passed. */
  private heldRefusal(): UsageRefusal | undefined {
    if (this.refusal && usageRefusalEnded(this.refusal, this.now())) this.refusal = undefined;
    return this.refusal;
  }

  private async readStatus(): Promise<ModelAccountStatus> {
    const loginStartEpoch = this.isLoginIdle() ? this.loginStartEpoch : null;
    let response: CodexAccountReadResponse;
    try {
      response = await this.manager.request<CodexAccountReadResponse>(Method.accountRead, {
        refreshToken: true,
      });
    } catch (err) {
      // A workspace routing 401 also matches. When the refresh succeeds but the
      // workspace keeps refusing the account, the next refresh clears the mark,
      // so the payer switches back and forth at each hourly status refresh.
      if (isCodexAuthRevokedError(err)) {
        if (this.noLoginSince(loginStartEpoch)) await this.markAuthRevoked();
      } else {
        log.warn("codex account/read failed; using auth file fallback", {
          error: getErrorMessage(err),
        });
      }
      return statusFromFile(await this.readFileStatus());
    }

    const fileStatus = await this.readFileStatus();
    if (fileStatus.needsReauth) return statusFromFile(fileStatus);

    const account =
      response.account && typeof response.account === "object"
        ? (response.account as Record<string, unknown>)
        : null;
    // A custom default provider has no OpenAI account of its own. Preserve the
    // saved guardian login so the payer resolver can select it again later.
    if (!account && !response.requiresOpenaiAuth) return statusFromFile(fileStatus);
    if (
      !account &&
      fileStatus.authMode === "chatgpt" &&
      fileStatus.loggedIn &&
      this.noLoginSince(loginStartEpoch)
    ) {
      // This account/read asked Codex to refresh the login. As of Codex 0.160
      // it hides the account of a saved ChatGPT login only once a refresh of
      // that login failed permanently, and it never records a transient
      // failure. It also hides an auth.json written after the app-server
      // started, which this marks too, and only a new sign-in clears that mark
      // until Codex restarts and refreshes the token. Marking the login keeps
      // the credits branch above, which cannot see the account, from reading
      // it as signed in.
      await this.markAuthRevoked();
      return statusFromFile(await this.readFileStatus());
    }
    if (!account) return { loggedIn: false, authMode: fileStatus.authMode ?? null };
    if (account.type === "apiKey") {
      return { loggedIn: true, authMode: "apikey", accountType: "api_key" };
    }
    if (account.type === "chatgpt") {
      const planType =
        typeof account.planType === "string"
          ? (account.planType as CodexPlanType)
          : fileStatus.planType;
      return {
        loggedIn: true,
        authMode: "chatgpt",
        planType,
        accountType: planType ?? fileStatus.accountType ?? "chatgpt",
        email: typeof account.email === "string" ? account.email : fileStatus.email,
      };
    }

    // Future account variants (for example an upstream custom provider) are
    // still authenticated, but do not grant ChatGPT-plan model access.
    return {
      loggedIn: true,
      authMode: fileStatus.authMode,
      planType: fileStatus.planType,
      accountType: typeof account.type === "string" ? account.type : fileStatus.accountType,
      email: fileStatus.email,
    };
  }

  private isLoginIdle(): boolean {
    return !this.activeLogin && !this.loginStartPending;
  }

  // A login that starts after account/read can write new tokens before
  // markAuthRevoked reads auth.json, which would fingerprint the new token.
  private noLoginSince(loginStartEpoch: number | null): boolean {
    return loginStartEpoch === this.loginStartEpoch && this.isLoginIdle();
  }

  async usage(): Promise<AIToolUsageStatus | null> {
    return await readLiveOrCachedUsage(
      async () => {
        try {
          const response = await this.manager.request<unknown>(Method.accountRateLimitsRead);
          return (
            normalizeUsageStatus(rateLimitsPayload(response), "codex app-server", {
              utilizationUnit: "fraction",
            }) ?? {
              checkedAt: new Date().toISOString(),
              source: "codex app-server",
              error: "Codex rate limit response did not include usage windows",
            }
          );
        } catch (err) {
          return {
            checkedAt: new Date().toISOString(),
            source: "codex app-server",
            error: getErrorMessage(err),
          };
        }
      },
      this.usageCachePaths,
      { utilizationUnit: "fraction" },
    );
  }

  authorizationState(): ModelAuthorizationState {
    return {
      running: this.activeLogin !== null,
      mode: this.activeLogin?.mode ?? null,
      userCode: this.activeLogin?.userCode ?? null,
      verificationUrl: this.activeLogin?.verificationUrl ?? null,
      lastError: this.lastLoginError,
    };
  }

  async startBrowserAuthorization(): Promise<ModelBrowserAuthorization> {
    await this.cancelAuthorization();
    this.assertOpen();
    if (this.loginStartPending) throw new Error("Codex login is already starting");
    const loginStartEpoch = ++this.loginStartEpoch;
    this.lastLoginError = null;
    this.loginStartPending = true;
    this.cancelPendingLoginStart = false;
    this.earlyLoginCompletion = null;
    try {
      const result = await this.manager.request<BrowserLoginResponse>(Method.accountLoginStart, {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      });
      if (typeof result.loginId !== "string" || typeof result.authUrl !== "string") {
        throw new Error("Codex login response did not include an auth URL");
      }
      if (
        !this.isCurrentLoginStart(loginStartEpoch) ||
        (await this.cancelStartedLoginIfRequested(result.loginId)) ||
        !this.isCurrentLoginStart(loginStartEpoch)
      ) {
        throw new Error("Codex login was canceled");
      }
      this.setActiveLogin(result.loginId, "browser", null, null);
      this.finishPendingLoginStart();
      return { authorizationId: result.loginId, authUrl: result.authUrl };
    } catch (err) {
      this.clearPendingLoginStart(loginStartEpoch);
      throw err;
    }
  }

  async startDeviceAuthorization(): Promise<ModelDeviceAuthorization> {
    await this.cancelAuthorization();
    this.assertOpen();
    if (this.loginStartPending) throw new Error("Codex login is already starting");
    const loginStartEpoch = ++this.loginStartEpoch;
    this.lastLoginError = null;
    this.loginStartPending = true;
    this.cancelPendingLoginStart = false;
    this.earlyLoginCompletion = null;
    try {
      const result = await this.manager.request<DeviceLoginResponse>(Method.accountLoginStart, {
        type: "chatgptDeviceCode",
      });
      if (
        typeof result.loginId !== "string" ||
        typeof result.userCode !== "string" ||
        typeof result.verificationUrl !== "string"
      ) {
        throw new Error("Codex device login response did not include a device code");
      }
      if (
        !this.isCurrentLoginStart(loginStartEpoch) ||
        (await this.cancelStartedLoginIfRequested(result.loginId)) ||
        !this.isCurrentLoginStart(loginStartEpoch)
      ) {
        throw new Error("Codex login was canceled");
      }
      this.setActiveLogin(result.loginId, "device", result.userCode, result.verificationUrl);
      this.finishPendingLoginStart();
      return {
        authorizationId: result.loginId,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
      };
    } catch (err) {
      this.clearPendingLoginStart(loginStartEpoch);
      throw err;
    }
  }

  async cancelAuthorization(): Promise<void> {
    if (this.loginStartPending) {
      this.cancelPendingLoginStart = true;
      this.lastLoginError = null;
      return;
    }
    const active = this.takeActiveLogin();
    this.lastLoginError = null;
    if (!active) return;
    try {
      await this.manager.request(Method.accountLoginCancel, { loginId: active.loginId });
    } catch (err) {
      // Cancellation is cleanup. Clear Rome's in-memory attempt even if the
      // app-server connection disappeared while the request was in flight.
      log.warn("codex account/login/cancel failed", {
        loginId: active.loginId,
        error: getErrorMessage(err),
      });
    }
  }

  async revoke(): Promise<void> {
    await this.cancelAuthorization();
    await this.manager.request(Method.accountLogout);
    this.refusal = undefined;
    this.emitAccountChanged();
  }

  /** The provider adapter saw the provider refuse a turn. A credential refusal is already in auth.json. */
  refusedTurn(refusal: RefusedTurn): void {
    if (refusal.kind === "usage") {
      this.refusal = usageRefusalAt(refusal, this.now());
    }
    this.emitAccountChanged();
  }

  onChanged(listener: () => void): () => void {
    this.accountChangedListeners.add(listener);
    return () => this.accountChangedListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.loginStartEpoch += 1;
    this.loginStartPending = false;
    this.cancelPendingLoginStart = false;
    this.earlyLoginCompletion = null;
    this.takeActiveLogin();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.accountChangedListeners.clear();
  }

  private setActiveLogin(
    loginId: string,
    mode: ModelAuthorizationMode,
    userCode: string | null,
    verificationUrl: string | null,
  ): void {
    const timeout = setTimeout(() => {
      const active = this.activeLogin;
      if (!active || active.loginId !== loginId) return;
      this.takeActiveLogin();
      this.lastLoginError =
        mode === "device"
          ? "Codex device code expired before login completed"
          : "Codex login timed out";
      void this.manager.request(Method.accountLoginCancel, { loginId }).catch((err) =>
        log.warn("timed-out Codex login could not be canceled", {
          loginId,
          error: getErrorMessage(err),
        }),
      );
    }, this.loginTimeoutMs);
    timeout.unref?.();
    this.activeLogin = { loginId, mode, userCode, verificationUrl, timeout };
  }

  private takeActiveLogin(): ActiveLogin | null {
    const active = this.activeLogin;
    this.activeLogin = null;
    if (active) clearTimeout(active.timeout);
    return active;
  }

  private handleLoginCompleted(params: unknown): void {
    const notification = (params ?? {}) as LoginCompletedNotification;
    const active = this.activeLogin;
    if (!active && this.loginStartPending) {
      this.earlyLoginCompletion = notification;
      return;
    }
    const loginId = typeof notification.loginId === "string" ? notification.loginId : null;
    if (active && loginId && loginId !== active.loginId) return;
    if (active) this.takeActiveLogin();
    if (notification.success === true) {
      this.lastLoginError = null;
    } else {
      this.lastLoginError =
        typeof notification.error === "string" && notification.error.trim()
          ? notification.error
          : "Codex login was not completed";
    }
    this.emitAccountChanged();
  }

  private finishPendingLoginStart(): void {
    const completion = this.earlyLoginCompletion;
    this.loginStartPending = false;
    this.earlyLoginCompletion = null;
    if (completion) this.handleLoginCompleted(completion);
  }

  private isCurrentLoginStart(loginStartEpoch: number): boolean {
    return !this.closed && this.loginStartEpoch === loginStartEpoch && this.loginStartPending;
  }

  private clearPendingLoginStart(loginStartEpoch: number): void {
    if (this.loginStartEpoch !== loginStartEpoch) return;
    this.loginStartPending = false;
    this.cancelPendingLoginStart = false;
    this.earlyLoginCompletion = null;
  }

  private async cancelStartedLoginIfRequested(loginId: string): Promise<boolean> {
    if (!this.cancelPendingLoginStart) return false;
    this.loginStartPending = false;
    this.cancelPendingLoginStart = false;
    this.earlyLoginCompletion = null;
    try {
      await this.manager.request(Method.accountLoginCancel, { loginId });
    } catch (err) {
      log.warn("pending Codex login could not be canceled after start completed", {
        loginId,
        error: getErrorMessage(err),
      });
    }
    return true;
  }

  private emitAccountChanged(): void {
    for (const listener of this.accountChangedListeners) {
      try {
        listener();
      } catch (err) {
        log.warn("Codex account change listener failed", { error: getErrorMessage(err) });
      }
    }
  }

  private handleManagerExit(error: Error): void {
    if (!this.activeLogin && !this.loginStartPending) return;
    this.loginStartEpoch += 1;
    this.takeActiveLogin();
    this.loginStartPending = false;
    this.cancelPendingLoginStart = false;
    this.earlyLoginCompletion = null;
    this.lastLoginError = `Codex sign-in stopped: ${error.message}`;
    this.emitAccountChanged();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("codex account service is closed");
  }
}
