import { Hono } from "hono";
import type { ProviderSwitch } from "../../webchat/provider-failures.js";
import { isDefaultProvider } from "../../agent/index.js";
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
} from "../../agent/index.js";
import { closeAuthTabs, openServerBrowserTab } from "./desktop.js";
import { getErrorMessage } from "../../lib/error-message.js";
import { fetchRomeCredits } from "../../agent/index.js";
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
  deps: Pick<
    ApiDeps,
    | "modelAccounts"
    | "codexAccountService"
    | "claudeAccount"
    | "defaultProviders"
    | "providerFailures"
    | "chatProviders"
    | "romeCreditsUsable"
  >,
): Hono {
  const app = new Hono();

  // The default provider, the providers it can be, the note a logout left,
  // how many chats a change moves, and whether Rome credits could run chats
  // once no AI account is logged in.
  const defaultJson = async () => {
    const defaults = deps.defaultProviders;
    if (!defaults) return null;
    await defaults.ready();
    const note = defaults.note();
    const followingChats = await deps.chatProviders?.followingCount().catch(() => 0);
    return {
      provider: defaults.current(),
      signedIn: defaults.signedIn(),
      ...(note ? { note } : {}),
      followingChats: followingChats ?? 0,
      romeCreditsUsable: deps.romeCreditsUsable?.() ?? false,
    };
  };

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
      defaultProvider: await defaultJson(),
    });
  });

  app.get("/ai-tools/default", async (c) => c.json({ defaultProvider: await defaultJson() }));

  // The guardian's choice of default, after the confirm dialog. With
  // `moveExisting` false, the chats that follow the default stay on the
  // provider they run on; otherwise each moves on its next run.
  app.put("/ai-tools/default", async (c) => {
    const defaults = deps.defaultProviders;
    if (!defaults) return c.json({ error: "No default provider here" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      provider?: unknown;
      moveExisting?: unknown;
    } | null;
    if (!isDefaultProvider(body?.provider)) return c.json({ error: "Unknown provider" }, 400);
    try {
      await defaults.choose(body.provider, { moveExisting: body.moveExisting !== false });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 409);
    }
    return c.json({ defaultProvider: await defaultJson() });
  });

  app.delete("/ai-tools/default/note", async (c) => {
    await deps.defaultProviders?.dismissNote();
    return c.json({ defaultProvider: await defaultJson() });
  });

  /** A card's or a notice's switch, as the body names it. */
  const switchOf = (body: unknown): ProviderSwitch | null => {
    if (typeof body !== "object" || body === null) return null;
    const value = body as Record<string, unknown>;
    if (value.kind === "model" && typeof value.selection === "string") {
      return { kind: "model", selection: value.selection };
    }
    if (value.kind === "provider" && isDefaultProvider(value.provider)) {
      return {
        kind: "provider",
        provider: value.provider,
        makeDefault: value.makeDefault === true,
      };
    }
    return null;
  };

  // A card's switch: this chat moves (and with `makeDefault`, the default
  // too), the card settles, and the stopped turn runs again.
  app.post("/ai-tools/provider-failures/:messageId/switch", async (c) => {
    if (!deps.providerFailures) return c.json({ error: "Not available" }, 404);
    const change = switchOf(await c.req.json().catch(() => null));
    if (!change) return c.json({ error: "A provider or a model is required" }, 400);
    try {
      await deps.providerFailures.switchCard(c.req.param("messageId"), change);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 409);
    }
  });

  // Runs a chat's stopped request again.
  app.post("/ai-tools/provider-failures/resend", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      chatId?: unknown;
      agentName?: unknown;
    } | null;
    if (typeof body?.chatId !== "string" || typeof body.agentName !== "string") {
      return c.json({ error: "chatId and agentName are required" }, 400);
    }
    if (!deps.providerFailures) return c.json({ error: "Not available" }, 404);
    try {
      await deps.providerFailures.resend(body.chatId, body.agentName);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 409);
    }
  });

  app.get("/ai-tools/provider-outages", async (c) => {
    const outages = (await deps.providerFailures?.outages()) ?? [];
    return c.json({
      outages: outages.map(({ id, provider, reason, until, chats, since }) => ({
        id,
        provider,
        reason,
        ...(until ? { until } : {}),
        chatIds: chats.map((chat) => chat.chatId),
        since,
      })),
    });
  });

  // A notice's switch: every chat the incident stopped moves, and runs again.
  app.post("/ai-tools/provider-outages/:id/switch", async (c) => {
    if (!deps.providerFailures) return c.json({ error: "Not available" }, 404);
    const change = switchOf(await c.req.json().catch(() => null));
    if (!change) return c.json({ error: "A provider or a model is required" }, 400);
    try {
      const moved = await deps.providerFailures.switchOutage(c.req.param("id"), change);
      return c.json({ moved });
    } catch (err) {
      return c.json({ error: getErrorMessage(err) }, 409);
    }
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
