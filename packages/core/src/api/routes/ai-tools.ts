import { Hono } from "hono";
import { createLogger } from "../../logger.js";
import type { ApiDeps } from "../deps.js";
import {
  accountAllowsModel,
  providerAuthorized,
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  type ClaudeLogins,
  type ModelAccountReport,
} from "../../agent/index.js";
import { validateCustomAnthropicEnv } from "@rome/api-types/anthropic-compatible-env";
import {
  CUSTOM_ANTHROPIC_PROVIDER_ID,
  isAnthropicCompatibleProviderId,
  listAnthropicCompatibleProviderSummaries,
} from "@rome/api-types/anthropic-compatible-providers";
import {
  summarizeAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentialsForEditing,
} from "../../lib/anthropic-compatible-providers.js";
import { closeAuthTabs, openServerBrowserTab } from "./desktop.js";
import { getErrorMessage } from "../../lib/provider-usage.js";
import { fetchRomeCredits } from "../../lib/rome-credits.js";
import type { RomeCreditsResponse } from "@rome/api-types/rome-credits";

const log = createLogger("api:ai-tools");

/**
 * The dashboard's shape of a provider's availability, unchanged since it was
 * read off the AI tool state: `loggedIn`, `quotaExhausted` and the account's
 * fields side by side. Unread providers show as not yet checked.
 */
function providerStatusJson(report: ModelAccountReport | undefined) {
  if (!report) return { quotaExhausted: false };
  const { state, usageLimitUntil, account, usage } = report;
  const { modelsDenied: _denied, usageLimited: _limited, ...rest } = account;
  return {
    ...rest,
    loggedIn: state !== "unauthorized" && state !== "expired",
    ...(state === "expired" ? { needsReauth: true } : {}),
    quotaExhausted: state === "usage_limit_reached",
    ...(usageLimitUntil ? { quotaExhaustedUntil: usageLimitUntil } : {}),
    ...(usage ? { usage } : {}),
  };
}

function codexStatusJson(report: ModelAccountReport | undefined) {
  // A logged-out account allows nothing, as the old state reported.
  const allows = (model: string): boolean =>
    report !== undefined && providerAuthorized(report) && accountAllowsModel(report.account, model);
  return {
    ...providerStatusJson(report),
    solAccess: allows(CODEX_SOL_MODEL),
    lunaAccess: allows(CODEX_LUNA_MODEL),
  };
}

/** Status never carries `env`: a custom credential's secret is in it. */
async function anthropicCompatibleJson(claude: Pick<ClaudeLogins, "storedCredential">) {
  const stored = await claude.storedCredential();
  const summary = summarizeAnthropicCompatibleCredentials(stored?.credential ?? null);
  return summary ? { ...summary, needsReauth: stored?.expired || undefined } : null;
}

export function aiToolsRoutes(
  deps: Pick<ApiDeps, "modelAccounts" | "codexAccountService" | "claudeAccount">,
): Hono {
  const app = new Hono();

  const statusJson = async () => {
    const state = deps.modelAccounts.read();
    return {
      claude: {
        ...providerStatusJson(state.anthropic),
        anthropicCompatible: await anthropicCompatibleJson(deps.claudeAccount),
      },
      codex: codexStatusJson(state.openai),
    };
  };

  app.get("/ai-tools/status", async (c) => {
    const { claude, codex } = await statusJson();
    const login = deps.codexAccountService.authorizationState();
    return c.json({
      claude,
      codex,
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
      anthropicCompatible: claude.anthropicCompatible,
    });
  });

  // Rome Cloud owns the balance; every instance of the account reads the same one.
  app.get("/ai-tools/rome-credits", async (c) => {
    try {
      const body: RomeCreditsResponse = { credits: await fetchRomeCredits() };
      return c.json(body);
    } catch (err) {
      log.warn("Rome credits unavailable", { error: getErrorMessage(err) });
      return c.json({ error: getErrorMessage(err) }, 503);
    }
  });

  app.get("/ai-tools/usage", (c) => {
    const state = deps.modelAccounts.read();
    return c.json({
      claude: state.anthropic?.usage ?? null,
      codex: state.openai?.usage ?? null,
    });
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
      await deps.modelAccounts.refresh(provider);
      return c.json(await statusJson());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Refresh failed" }, 500);
    }
  });

  app.get("/ai-tools/anthropic-compatible-providers", async (c) => {
    const stored = await deps.claudeAccount.storedCredential();
    const configured = summarizeAnthropicCompatibleCredentialsForEditing(
      stored?.credential ?? null,
    );
    return c.json({
      providers: listAnthropicCompatibleProviderSummaries(),
      configured: configured ? { ...configured, needsReauth: stored?.expired } : null,
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

      const credential = {
        provider: CUSTOM_ANTHROPIC_PROVIDER_ID,
        env: validated.env,
        updatedAt: new Date().toISOString(),
      };
      await deps.claudeAccount.storeCredential(credential);
      await deps.modelAccounts.refresh("anthropic");
      return c.json({
        ok: true,
        configured: summarizeAnthropicCompatibleCredentialsForEditing(credential),
      });
    }

    if (!isAnthropicCompatibleProviderId(provider)) {
      return c.json({ error: "Unsupported Anthropic-compatible provider" }, 400);
    }
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return c.json({ error: "API key is required" }, 400);
    }

    const credential = { provider, apiKey: apiKey.trim(), updatedAt: new Date().toISOString() };
    await deps.claudeAccount.storeCredential(credential);
    await deps.modelAccounts.refresh("anthropic");
    return c.json({
      ok: true,
      configured: summarizeAnthropicCompatibleCredentialsForEditing(credential),
    });
  });

  app.delete("/ai-tools/anthropic-compatible-credentials", async (c) => {
    await deps.claudeAccount.removeCredential();
    await deps.modelAccounts.refresh("anthropic");
    return c.json({ ok: true });
  });

  // Start ChatGPT OAuth on the shared app-server and open the returned URL in
  // the noVNC-visible server browser. Completion arrives as the process-global
  // `account/login/completed` notification on that same connection.
  app.post("/ai-tools/codex/login/start", async (c) => {
    await closeAuthTabs();
    try {
      const login = await deps.codexAccountService.startBrowserAuthorization();
      const opened = await openServerBrowserTab(login.authUrl);
      if (!opened.ok) {
        await deps.codexAccountService.cancelAuthorization();
        return c.json({ error: opened.error }, opened.status as 502 | 503);
      }
      return c.json({ started: true });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  app.post("/ai-tools/codex/login/cancel", async (c) => {
    await deps.codexAccountService.cancelAuthorization();
    return c.json({ ok: true });
  });

  // Device-code login uses the same shared app-server and account service.
  app.post("/ai-tools/codex/device-login/start", async (c) => {
    try {
      const state = await deps.codexAccountService.startDeviceAuthorization();
      return c.json({
        userCode: state.userCode,
        verificationUrl: state.verificationUrl,
      });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 500);
    }
  });

  app.post("/ai-tools/codex/device-login/cancel", async (c) => {
    await deps.codexAccountService.cancelAuthorization();
    return c.json({ ok: true });
  });

  // Re-read the account on success so the agent gate reflects it immediately.
  app.post("/ai-tools/claude/logout", async (c) => {
    try {
      await deps.claudeAccount.revoke();
    } catch (err) {
      const error = getErrorMessage(err);
      log.warn("claude logout failed", { error });
      return c.json({ error }, 500);
    }
    await deps.modelAccounts.refresh("anthropic");
    return c.json({ ok: true });
  });

  // Log out of Codex via the app-server `account/logout` RPC (no PTY terminal).
  // Re-probe login state on success so the agent gate reflects it immediately.
  app.post("/ai-tools/codex/logout", async (c) => {
    try {
      await deps.codexAccountService.revoke();
      await deps.modelAccounts.refresh("openai");
      return c.json({ ok: true });
    } catch (err) {
      const error = getErrorMessage(err);
      log.warn("codex logout failed", { error });
      return c.json({ error }, 500);
    }
  });

  return app;
}
