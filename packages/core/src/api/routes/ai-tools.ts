import { execFile } from "node:child_process";
import { Hono } from "hono";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";
import {
  clearClaudeAuthRevoked,
  clearStoredAnthropicCompatibleAuthRevoked,
  isAnthropicCompatibleAuthRevoked,
} from "../../lib/anthropic-login.js";
import {
  ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING,
  CUSTOM_ANTHROPIC_PROVIDER_ID,
  getStoredAnthropicCompatibleCredentials,
  isAnthropicCompatibleProviderId,
  listAnthropicCompatibleProviderSummaries,
  summarizeAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentialsForEditing,
  validateCustomAnthropicEnv,
  type StoredAnthropicCompatibleCredentials,
} from "../../lib/anthropic-compatible-providers.js";
import { closeAuthTabs, openServerBrowserTab } from "./desktop.js";
import { getErrorMessage } from "../../lib/provider-usage.js";

// Re-exported for existing consumers (and the ai-tools route tests) that import
// the usage parser from this module.
export {
  normalizeUsageStatus,
  parseUsageText,
  readLiveOrCachedUsage,
} from "../../lib/provider-usage.js";

const log = createLogger("api:ai-tools");

// Log out of Claude by running `claude auth logout` (non-interactive, so no PTY
// terminal — mirrors getClaudeStatus's execFile usage).
function logoutClaude(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "logout"], { timeout: 10_000 }, (err) => {
      resolve(err ? { ok: false, error: getErrorMessage(err) } : { ok: true });
    });
  });
}

export function aiToolsRoutes(
  deps: Pick<ApiDeps, "settingsRepo" | "aiToolState" | "codexAccountService">,
): Hono {
  const app = new Hono();

  app.get("/ai-tools/status", (c) => {
    const state = deps.aiToolState.get();
    const login = deps.codexAccountService.getLoginState();
    return c.json({
      claude: state.claude,
      codex: state.codex,
      codexLogin: {
        running: login.running && login.mode === "browser",
        lastExit: null,
        lastError: login.lastError,
      },
      codexDeviceLogin: {
        running: login.running && login.mode === "device",
        userCode: login.mode === "device" ? login.userCode : null,
        verificationUrl: login.mode === "device" ? login.verificationUrl : null,
        lastError: login.lastError,
      },
      anthropicCompatible: state.claude.anthropicCompatible ?? null,
    });
  });

  app.get("/ai-tools/usage", (c) => {
    const state = deps.aiToolState.get();
    return c.json({ claude: state.claude.usage ?? null, codex: state.codex.usage ?? null });
  });

  app.post("/ai-tools/refresh", async (c) => {
    try {
      // Optional `provider` scopes the refresh to one tool. The login dialog
      // polls `?provider=anthropic` so an unrelated slow Codex probe can never
      // stall Claude login detection; no provider refreshes everything (the
      // manual Refresh button). `refresh(provider)` is already ordered against
      // revocation via the shared per-provider in-flight lock.
      const providerParam = c.req.query("provider");
      const provider =
        providerParam === "anthropic" || providerParam === "openai" ? providerParam : undefined;
      return c.json(await deps.aiToolState.refresh(provider));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Refresh failed" }, 500);
    }
  });

  app.get("/ai-tools/anthropic-compatible-providers", async (c) => {
    const [credentials, revoked] = await Promise.all([
      getStoredAnthropicCompatibleCredentials(deps.settingsRepo),
      isAnthropicCompatibleAuthRevoked(deps.settingsRepo),
    ]);
    const configured = summarizeAnthropicCompatibleCredentialsForEditing(credentials);
    return c.json({
      providers: listAnthropicCompatibleProviderSummaries(),
      configured: configured ? { ...configured, needsReauth: revoked } : null,
    });
  });

  app.put("/ai-tools/anthropic-compatible-credentials", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const provider = body?.provider;
    const apiKey = body?.apiKey;

    if (provider === CUSTOM_ANTHROPIC_PROVIDER_ID) {
      const validated = validateCustomAnthropicEnv(body?.env);
      if (!validated.ok) {
        return c.json({ error: validated.error }, 400);
      }

      const credentials: StoredAnthropicCompatibleCredentials = {
        provider: CUSTOM_ANTHROPIC_PROVIDER_ID,
        env: validated.env,
        updatedAt: new Date().toISOString(),
      };
      await deps.settingsRepo.set(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING, credentials);
      await clearStoredAnthropicCompatibleAuthRevoked();
      await deps.aiToolState.refresh("anthropic");
      return c.json({
        ok: true,
        configured: summarizeAnthropicCompatibleCredentialsForEditing(credentials),
      });
    }

    if (!isAnthropicCompatibleProviderId(provider)) {
      return c.json({ error: "Unsupported Anthropic-compatible provider" }, 400);
    }
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return c.json({ error: "API key is required" }, 400);
    }

    const updatedAt = new Date().toISOString();
    const trimmedApiKey = apiKey.trim();
    await deps.settingsRepo.set(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING, {
      provider,
      apiKey: trimmedApiKey,
      updatedAt,
    });
    await clearStoredAnthropicCompatibleAuthRevoked();
    await deps.aiToolState.refresh("anthropic");

    return c.json({
      ok: true,
      configured: summarizeAnthropicCompatibleCredentials({
        provider,
        apiKey: trimmedApiKey,
        updatedAt,
      }),
    });
  });

  app.delete("/ai-tools/anthropic-compatible-credentials", async (c) => {
    await deps.settingsRepo.delete(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING);
    await clearStoredAnthropicCompatibleAuthRevoked();
    await deps.aiToolState.refresh("anthropic");
    return c.json({ ok: true });
  });

  // Start ChatGPT OAuth on the shared app-server and open the returned URL in
  // the noVNC-visible server browser. Completion arrives as the process-global
  // `account/login/completed` notification on that same connection.
  app.post("/ai-tools/codex/login/start", async (c) => {
    await closeAuthTabs();
    try {
      const login = await deps.codexAccountService.startBrowserLogin();
      const opened = await openServerBrowserTab(login.authUrl);
      if (!opened.ok) {
        await deps.codexAccountService.cancelLogin();
        return c.json({ error: opened.error }, opened.status as 502 | 503);
      }
      return c.json({ started: true });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  app.post("/ai-tools/codex/login/cancel", async (c) => {
    await deps.codexAccountService.cancelLogin();
    return c.json({ ok: true });
  });

  // Device-code login uses the same shared app-server and account service.
  app.post("/ai-tools/codex/device-login/start", async (c) => {
    try {
      const state = await deps.codexAccountService.startDeviceLogin();
      return c.json({
        userCode: state.userCode,
        verificationUrl: state.verificationUrl,
      });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  app.post("/ai-tools/codex/device-login/cancel", async (c) => {
    await deps.codexAccountService.cancelLogin();
    return c.json({ ok: true });
  });

  // Re-probe login state on success so the agent gate reflects it immediately.
  app.post("/ai-tools/claude/logout", async (c) => {
    const result = await logoutClaude();
    if (!result.ok) {
      log.warn("claude logout failed", { error: result.error });
      return c.json({ error: result.error ?? "Claude logout failed" }, 500);
    }
    await clearClaudeAuthRevoked();
    await deps.aiToolState.refresh("anthropic");
    return c.json({ ok: true });
  });

  // Log out of Codex via the app-server `account/logout` RPC (no PTY terminal).
  // Re-probe login state on success so the agent gate reflects it immediately.
  app.post("/ai-tools/codex/logout", async (c) => {
    try {
      await deps.codexAccountService.logout();
      await deps.aiToolState.refresh("openai");
      return c.json({ ok: true });
    } catch (err) {
      const error = getErrorMessage(err);
      log.warn("codex logout failed", { error });
      return c.json({ error }, 500);
    }
  });

  return app;
}
