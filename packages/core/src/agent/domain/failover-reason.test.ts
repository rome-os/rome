import { expect, it } from "@rstest/core";
import {
  failoverReason,
  providerFailureReason,
  type FailoverReason,
  type ProviderFailureReason,
} from "./failover-reason.js";
import type { ModelAccountStatus } from "./model-account.js";
import type {
  ModelAccountReport,
  ModelAccountReports,
  ProviderAvailabilityState,
} from "./model-account-report.js";

const reportOf = (
  state: ProviderAvailabilityState,
  account: Partial<ModelAccountStatus> = {},
): ModelAccountReport => ({
  state,
  account: { loggedIn: state !== "unauthorized", ...account },
});

const state = (): ModelAccountReports => ({
  anthropic: reportOf("available"),
  openai: reportOf("available"),
});
it.each<[string, FailoverReason | null]>([
  ["exceeded retry limit, last status: 429 Too Many Requests", "temporary"],
  ["Repeated 529 Overloaded errors", "temporary"],
  ["API Error: 503", "temporary"],
  ["Request timed out", "temporary"],
  ["Connection error", "temporary"],
  ["connect ECONNREFUSED 127.0.0.1:443", "temporary"],
  ["Connection refused", "temporary"],
  ["unexpected status 503 Service Unavailable", "temporary"],
  ["Order 500 was not found", null],
  ["Could not read report-403.txt", null],
  ["stream disconnected before completion: connection closed", "temporary"],
  ["Server is temporarily limiting requests (not your usage limit)", "temporary"],
  ["Selected model is at capacity. Please try a different model.", "model_limit"],
  [
    "There's an issue with the selected model (X). It may not exist or you may not have access to it.",
    "model_limit",
  ],
  ["You've hit your Sonnet limit", "model_limit"],
  ["You've hit your Opus limit", "model_limit"],
  ["You've hit your Fable 5 limit", "model_limit"],
  ["You've hit your session limit · resets 9pm (America/Los_Angeles)", "quota"],
  ["You've hit your weekly limit", "quota"],
  ["You've hit your limit", "quota"],
  ["You're out of usage credits", "quota"],
  ["monthly spend limit", "quota"],
  ["team's shared budget", "quota"],
  ["Failed to authenticate: OAuth session expired and could not be refreshed", "login"],
  ["unexpected status 401 Unauthorized: Incorrect API key provided: ...", "login"],
  ["Prompt is too long", null],
  ["context_window_exceeded", null],
  ["prompt_too_long", null],
  ["max_tokens", null],
  ["Content refusal", null],
  ["User stopped the turn", null],
  ["Reached maximum number of turns (5)", null],
  ["Codex stopped before the turn finished: Rome is shutting down", null],
  ["Rome restarted while this was running. The task did not finish.", null],
  ["Agent ended the turn without calling submit_output...", null],
  ["Claude Agent SDK completed without structured output", null],
  ["Credit balance is too low", null],
  ["Claude Code process exited with code 1", null],
  ["unknown failure", null],
])("classifies %s as %s", (message, expected) => {
  expect(failoverReason({ message, provider: "anthropic" }, state())).toBe(expected);
});
it.each([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "cloud_credential_error",
])("accepts SDK %s", (providerError) => {
  expect(
    failoverReason({ message: "Sign-in error", provider: "anthropic", providerError }, state()),
  ).toBe("login");
});
it("keeps exclusions and model wording ahead of generic kinds and statuses", () => {
  for (const message of [
    "Prompt is too long",
    "max_tokens",
    "Rome is shutting down",
    "Reached maximum number of turns (3)",
    "Credit balance is too low",
    "Claude Code process exited with code 1",
  ])
    expect(
      failoverReason({ message, provider: "openai", code: "transient", httpStatus: 529 }, state()),
    ).toBeNull();
  expect(
    failoverReason(
      {
        message: "You've hit your Sonnet limit",
        provider: "anthropic",
        providerError: "rate_limit",
        httpStatus: 429,
      },
      state(),
    ),
  ).toBe("model_limit");
  for (const patch of [
    { httpStatus: 400 },
    { code: "invalid_request" as const },
    { providerError: "max_output_tokens" },
  ])
    expect(
      failoverReason({ message: "Connection error", provider: "openai", ...patch }, state()),
    ).toBeNull();
  for (const patch of [
    { code: "usage_limit" as const },
    { code: "credits_used_up" as const },
    { reason: "quota_exhausted" as const },
  ])
    expect(failoverReason({ message: "Limited", provider: "openai", ...patch }, state())).toBe(
      "quota",
    );
});
it("does not recover a turn Rome credits paid for, unless the credits ran out or the login failed", () => {
  const raw = state();
  raw.openai = reportOf("unauthorized");
  const failed = (extra: object) =>
    failoverReason({ provider: "openai", message: "Selected model is busy", ...extra }, raw);
  expect(failed({ code: "transient" })).toBeNull();
  expect(failed({ httpStatus: 503 })).toBeNull();
  expect(failed({ code: "model_unavailable" })).toBeNull();
  expect(failed({ code: "credits_used_up" })).toBe("quota");
  expect(failed({ code: "auth_revoked" })).toBe("login");
  expect(failed({ reason: "not_logged_in" })).toBe("login");
});

it("refuses API key sources, unknown providers and absent failures", () => {
  const raw = state();
  raw.anthropic = reportOf("available", { authMethod: "environment", usageLimited: false });
  raw.openai = reportOf("available", { accountType: "api_key", usageLimited: false });
  for (const provider of ["openai", "anthropic", "anthropic-compatible"])
    expect(
      failoverReason(
        {
          provider,
          message: "unexpected status 401 Unauthorized: Incorrect API key provided: ...",
        },
        raw,
      ),
    ).toBeNull();
  expect(failoverReason(undefined, raw)).toBeNull();
});

it.each([
  { code: "model_unavailable" },
  { reason: "model_access_denied" },
  { code: "model_unavailable", httpStatus: 400 },
  { reason: "model_access_denied", httpStatus: 403 },
] as const)("classifies structured model refusal %j before generic statuses", (fields) => {
  const failure = { message: "Model not served", provider: "openai", ...fields };
  expect(failoverReason(failure, state())).toBe("model_limit");
  const raw = state();
  raw.openai = reportOf("available", { accountType: "api_key", usageLimited: false });
  expect(failoverReason(failure, raw)).toBeNull();
});

it.each<[string, Parameters<typeof providerFailureReason>[0], ProviderFailureReason | null]>([
  ["a rate limit", { provider: "anthropic", message: "x", httpStatus: 429 }, "temporary"],
  ["a 5xx", { provider: "openai", message: "API Error: 503" }, "temporary"],
  ["the network", { provider: "openai", message: "fetch failed" }, "temporary"],
  [
    "one model's limit",
    { provider: "anthropic", message: "You've hit your Opus limit" },
    "capacity",
  ],
  [
    "a model at capacity",
    { provider: "openai", message: "Selected model is at capacity." },
    "capacity",
  ],
  [
    "a model not in the plan",
    { provider: "openai", message: "nope", reason: "model_access_denied" },
    "model_unavailable",
  ],
  [
    "a model no longer offered",
    { provider: "anthropic", message: "x", providerError: "model_not_found" },
    "model_unavailable",
  ],
  ["the quota", { provider: "anthropic", message: "x", code: "usage_limit" }, "quota"],
  [
    "a spending limit",
    { provider: "anthropic", message: "monthly spend limit reached" },
    "spend_cap",
  ],
  [
    "a shared budget",
    { provider: "anthropic", message: "Your team's shared budget is spent" },
    "spend_cap",
  ],
  [
    "used-up credits",
    { provider: "openai", message: "x", code: "credits_used_up" },
    "credits_used_up",
  ],
  ["a revoked login", { provider: "openai", message: "x", code: "auth_revoked" }, "login"],
  ["no login", { provider: "anthropic", message: "x", reason: "not_logged_in" }, "removed"],
  ["a prompt too long", { provider: "anthropic", message: "Prompt is too long" }, null],
])("classifies %s for its card", (_label, failure, expected) => {
  expect(providerFailureReason(failure, state())).toBe(expected);
});

it("classifies Codex on Rome credits as the credits fail, not as a missing ChatGPT login", () => {
  const onCredits = { ...state(), openai: reportOf("unauthorized") };
  expect(
    providerFailureReason({ provider: "openai", message: "x", code: "usage_limit" }, onCredits),
  ).toBe("credits_used_up");
  expect(providerFailureReason({ provider: "openai", message: "API Error: 502" }, onCredits)).toBe(
    "temporary",
  );
});

it("cards an API key's failures too, which have no subscription to recover", () => {
  const apiKey = {
    ...state(),
    anthropic: reportOf("available", { authMethod: "environment", usageLimited: false }),
  };
  expect(
    providerFailureReason({ provider: "anthropic", message: "x", httpStatus: 401 }, apiKey),
  ).toBe("login");
});
