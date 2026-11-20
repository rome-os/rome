// Model resolution: which provider and model a run uses. The ask is a tier or
// an exact model, and resolveModel answers it from facts the resolver reads.
// A provider must be usable first, then its login must allow the model.
// docs/domains/agents.md carries the language.

import {
  accountAllowsModel,
  type AccountedProviderId,
  type ModelAccountReport,
  type ModelAccountReports,
  type ProviderAvailabilityState,
  providerAuthorized,
  providerUsable,
} from "./model-account-report.js";
import { stripLegacyReasoningSuffix } from "./model-alias.js";
import type { CodexLogin } from "./model-login.js";
import type { ProviderId } from "./model-port.js";
import {
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  MODEL_SELECTIONS,
  type ModelSelectionId,
} from "./model-selection.js";
import type { ModelTier } from "./model-tier.js";
import { providerAvailability } from "./provider-availability.js";
import { providerOfDefault, signedInProviders, type DefaultProvider } from "./default-provider.js";
import { followingSelection } from "./model-strength.js";

/**
 * What a run asks for. `providerId` on a tier restricts it to that provider's
 * guardian account. A tier without one follows the default provider: `pin` is
 * the model the session last ran, kept while it is on that provider, and
 * `override` runs this one ask on another provider (the guardian's "run them
 * on {other} now").
 */
export type ModelResolutionRequest = (
  | {
      kind: "tier";
      tier: ModelTier;
      providerId?: ProviderId;
      pin?: { providerId: ProviderId; model: string };
      override?: AccountedProviderId;
    }
  | { kind: "exact"; providerId: ProviderId; model: string }
) & {
  /**
   * The ask may spend Rome credits: its chat was moved onto them. Without it,
   * only a default of Rome credits spends them.
   */
  credits?: boolean;
};

/** The guardian's choice of model for each tier and provider. */
export type TierModels = Partial<Record<AccountedProviderId, Partial<Record<ModelTier, string>>>>;

/** Port. The guardian's tier models, read for each tier ask. */
export interface TierModelsSetting {
  /** Malformed and blank values read as absent. */
  read(): Promise<TierModels>;
}

/** What the rule reads. The resolver reads each once per ask. */
export interface ModelResolutionFacts {
  /** The providers this Rome runs. The order they are tried in is the rule's. */
  providers: readonly ProviderId[];
  reports: ModelAccountReports;
  /** The login in effect per provider, where it changes resolution. Only Codex's does today. */
  logins: { openai?: CodexLogin };
  /** Read only for a tier ask. */
  tierModels?: TierModels;
  /**
   * The provider a tier that follows the default runs on. Null when none is
   * set. Undefined keeps the order Rome used before the default existed.
   */
  defaultProvider?: DefaultProvider | null;
}

/** Why no provider can serve the ask, as facts. The resolver words them. */
export type ModelResolutionFailure =
  | {
      kind: "provider_unavailable";
      provider: AccountedProviderId;
      availability: Exclude<ProviderAvailabilityState, "available">;
      usageLimitUntil?: string;
      /** The ask followed the default provider rather than naming a model. */
      followsDefault?: boolean;
    }
  | { kind: "model_not_allowed"; provider: "openai"; model: string }
  | { kind: "none_usable"; allAtUsageLimit: boolean };

export type ModelResolutionOutcome =
  | { ok: true; providerId: ProviderId; model: string }
  | { ok: false; failure: ModelResolutionFailure };

const CLAUDE_TIER_MODELS: Record<ModelTier, string> = {
  large: "claude-opus-5-5[1m]",
  medium: "claude-sonnet-5-5",
  small: "claude-haiku-5-5",
};

const MOCK_TIER_MODELS: Record<ModelTier, string> = CLAUDE_TIER_MODELS;

/**
 * How Codex is reached for this ask. On Rome credits the guardian's plan does
 * not limit the models: the gateway's list does, when it has said.
 */
interface CodexTerms {
  report: ModelAccountReport | undefined;
  credits: boolean;
  served: ReadonlySet<string> | null;
}

function codexAllows(terms: CodexTerms, model: string): boolean {
  if (terms.served) return terms.served.has(stripLegacyReasoningSuffix(model));
  return terms.credits || !terms.report || accountAllowsModel(terms.report.account, model);
}

function codexTierModel(tier: ModelTier, terms: CodexTerms): string {
  const preferred = tier === "small" ? CODEX_LUNA_MODEL : CODEX_SOL_MODEL;
  return codexAllows(terms, preferred) ? preferred : CODEX_TERRA_MODEL;
}

function tierModel(
  providerId: ProviderId,
  tier: ModelTier,
  tierModels: TierModels | undefined,
  codex: CodexTerms,
): string {
  if (providerId === "mock") return MOCK_TIER_MODELS[tier];
  const chosen = tierModels?.[providerId]?.[tier];
  if (chosen) return chosen;
  return providerId === "openai" ? codexTierModel(tier, codex) : CLAUDE_TIER_MODELS[tier];
}

function unusable(
  providerId: ProviderId,
  reports: ModelAccountReports,
  login: CodexLogin | undefined,
): ModelResolutionFailure | undefined {
  if (providerId === "mock") return undefined;
  const report = reports[providerId];
  if (!report) return undefined;
  const availability = providerAvailability(report, providerId === "openai" ? login : undefined);
  if (availability === "available") return undefined;
  return {
    kind: "provider_unavailable",
    provider: providerId,
    availability,
    ...(report.usageLimitUntil ? { usageLimitUntil: report.usageLimitUntil } : {}),
  };
}

function notAllowed(
  providerId: ProviderId,
  model: string,
  codex: CodexTerms,
): ModelResolutionFailure | undefined {
  if (providerId !== "openai" || codexAllows(codex, model)) return undefined;
  return { kind: "model_not_allowed", provider: "openai", model };
}

function answer(
  providerId: ProviderId,
  model: string,
  failure: ModelResolutionFailure | undefined,
): ModelResolutionOutcome {
  return failure ? { ok: false, failure } : { ok: true, providerId, model };
}

/**
 * An exact ask resolves to exactly that model or fails. A tier restricted to a
 * provider runs there. Any other tier runs on the default provider, or the
 * provider its override names, and fails when that provider cannot run: no
 * other provider stands in. Without a default setting, a tier resolves on the
 * first usable provider in the order Rome used before: Codex subscription
 * capacity, Claude, Codex on ChatGPT credits, Codex on Rome credits, then the
 * mock. When the chosen provider's login does not allow the tier's model, the
 * ask fails rather than trying another provider.
 */
export function resolveModel(
  request: ModelResolutionRequest,
  facts: ModelResolutionFacts,
): ModelResolutionOutcome {
  const { reports } = facts;
  // A Rome credits login serves Codex only for an ask that may spend credits:
  // the guardian made them the default or moved this chat onto them. Any
  // other ask reads the guardian's own ChatGPT account, which shows its card.
  // With no default set, credits run only while no AI account is logged in.
  const spendsCredits =
    request.credits === true ||
    facts.defaultProvider === "rome_credits" ||
    (!facts.defaultProvider && signedInProviders(reports, true).rome_credits);
  const login =
    facts.logins.openai?.kind === "rome_credits" && !spendsCredits
      ? undefined
      : facts.logins.openai;
  const credits = login?.kind === "rome_credits";
  const served =
    login?.kind === "rome_credits" && login.modelsServed ? new Set(login.modelsServed) : null;
  const codex: CodexTerms = { report: reports.openai, credits, served };
  const runs = (providerId: ProviderId): boolean => facts.providers.includes(providerId);

  if (request.kind === "exact") {
    const { providerId, model } = request;
    return answer(
      providerId,
      model,
      unusable(providerId, reports, login) ?? notAllowed(providerId, model, codex),
    );
  }

  const onTier = (providerId: ProviderId, terms = codex): ModelResolutionOutcome => {
    const model = tierModel(providerId, request.tier, facts.tierModels, terms);
    return answer(providerId, model, notAllowed(providerId, model, terms));
  };

  // A tier restricted to one provider asks about the guardian's own account,
  // so Rome credits do not count. Image generation needs ChatGPT's hosted
  // tools, which the credits gateway rejects.
  if (request.providerId) {
    const failure = unusable(request.providerId, reports, undefined);
    if (failure) return { ok: false, failure };
    return onTier(request.providerId, { report: reports.openai, credits: false, served: null });
  }

  const following =
    request.override ??
    (facts.defaultProvider ? providerOfDefault(facts.defaultProvider) : facts.defaultProvider);
  if (following !== undefined) return onDefault(following);

  // Before the default existed: the pin decides, else the first usable
  // provider in a fixed order.
  if (request.pin) {
    const { providerId, model } = request.pin;
    return answer(
      providerId,
      model,
      unusable(providerId, reports, login) ?? notAllowed(providerId, model, codex),
    );
  }
  const codexAccountUsable = runs("openai") && providerUsable(reports.openai);
  if (codexAccountUsable && !reports.openai?.requiresChatgptCredits) return onTier("openai");
  if (runs("anthropic") && providerUsable(reports.anthropic)) return onTier("anthropic");
  if (codexAccountUsable) return onTier("openai");
  // Rome credits take a tier only when no guardian account can, and only one
  // whose default model the gateway serves. A tier model the guardian chose is
  // taken as asked, and fails if the gateway does not serve it.
  const creditsServeTier =
    !served ||
    Boolean(facts.tierModels?.openai?.[request.tier]) ||
    served.has(codexTierModel(request.tier, codex));
  if (runs("openai") && credits && creditsServeTier) return onTier("openai");
  if (runs("mock")) return onTier("mock");

  return noneUsable();

  // The default provider runs the ask, or nothing does: no other provider
  // stands in. Within it the session keeps the model it last ran.
  function onDefault(provider: AccountedProviderId | null): ModelResolutionOutcome {
    if (provider === null || !runs(provider)) return runs("mock") ? onTier("mock") : noneUsable();
    const failure = unusable(provider, reports, login);
    if (failure) {
      return {
        ok: false,
        failure:
          failure.kind === "provider_unavailable" ? { ...failure, followsDefault: true } : failure,
      };
    }
    const pin = request.kind === "tier" ? request.pin : undefined;
    if (pin && pin.providerId === provider && !notAllowed(provider, pin.model, codex)) {
      return { ok: true, providerId: provider, model: pin.model };
    }
    return onTier(provider);
  }

  function noneUsable(): ModelResolutionOutcome {
    // On Rome credits Codex counts as connected and not at its limit.
    const connected: ProviderAvailabilityState[] = [];
    if (runs("openai")) {
      if (credits) connected.push("available");
      else if (reports.openai && providerAuthorized(reports.openai))
        connected.push(reports.openai.state);
    }
    if (runs("anthropic") && reports.anthropic && providerAuthorized(reports.anthropic)) {
      connected.push(reports.anthropic.state);
    }
    return {
      ok: false,
      failure: {
        kind: "none_usable",
        allAtUsageLimit:
          connected.length > 0 && connected.every((state) => state === "usage_limit_reached"),
      },
    };
  }
}

/**
 * The ask: the chat's exact selection, else the agent's exact model, else its
 * tier. A tier that names no provider follows the default provider and keeps
 * the session's pin while the pin is on that provider. `override` runs this
 * one ask on another provider, and `credits` runs it on Codex through Rome
 * credits.
 * Throws on an agent with neither a tier nor a provider and model, or with a
 * model beside a tier.
 */
export function modelResolutionRequest(
  selectionId: ModelSelectionId | undefined,
  pin: { providerId: ProviderId; model: string } | undefined,
  agent: { tier?: ModelTier; providerId?: ProviderId; modelId?: string },
  override?: AccountedProviderId,
  credits?: boolean,
): ModelResolutionRequest {
  if (!credits) return modelAsk(selectionId, pin, agent, override);
  // Rome credits run Codex: the chat's model, whoever chose it, runs at its
  // strength there.
  return { ...modelAsk(selectionId, pin, agent, override ?? "openai"), credits: true };
}

function modelAsk(
  selectionId: ModelSelectionId | undefined,
  pin: { providerId: ProviderId; model: string } | undefined,
  agent: { tier?: ModelTier; providerId?: ProviderId; modelId?: string },
  override?: AccountedProviderId,
): ModelResolutionRequest {
  if (selectionId) {
    // A one-off override runs the selection's strength on that provider.
    const id = override ? followingSelection(selectionId, override) : selectionId;
    const { providerId, model } = MODEL_SELECTIONS[id];
    return { kind: "exact", providerId, model };
  }
  if (agent.modelId !== undefined) {
    if (!agent.providerId || !agent.modelId || agent.tier !== undefined) {
      throw new Error("An agent modelId requires a provider and cannot be combined with tier");
    }
    if (pin && pin.providerId === agent.providerId) return { kind: "exact", ...pin };
    return { kind: "exact", providerId: agent.providerId, model: agent.modelId };
  }
  if (!agent.tier) {
    throw new Error("Agent config requires a tier or a provider with modelId");
  }
  if (agent.providerId) {
    // Restricted to one provider: the pin still holds the model it last ran there.
    if (pin && pin.providerId === agent.providerId) return { kind: "exact", ...pin };
    return { kind: "tier", tier: agent.tier, providerId: agent.providerId };
  }
  return {
    kind: "tier",
    tier: agent.tier,
    ...(pin ? { pin } : {}),
    ...(override ? { override } : {}),
  };
}
