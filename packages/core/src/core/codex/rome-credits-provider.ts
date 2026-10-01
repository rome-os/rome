// The Rome credits model provider on the shared `codex app-server`.
//
// Rome credits are an account-wide allowance Rome Cloud serves through its
// Responses-compatible inference gateway at `<Rome Cloud origin>/v1`. The one
// shared app-server knows two providers: its default (the guardian's own
// OpenAI login) and `rome_credits`. A conversation runs on credits only when
// its thread is started or resumed with `modelProvider: "rome_credits"`.
//
// Codex 0.156 resolves a resumed thread's provider from the request, not from
// the thread's history, so every resume must name the provider again. On a
// loaded thread in `systemError` it ignores resume overrides until the thread
// unloads, which is why the unload delay is zero.

/** Codex provider id for Rome credits. */
export const ROME_CREDITS_MODEL_PROVIDER_ID = "rome_credits";

/** Env var the app-server reads the instance credential from on each request. */
export const ROME_CREDITS_TOKEN_ENV = "ROME_CREDITS_TOKEN";

function tomlString(value: string): string {
  // JSON string escapes are valid TOML basic-string escapes.
  return JSON.stringify(value);
}

/**
 * Root `-c` overrides for `codex app-server`.
 *
 * `thread_unload_delay_secs=0` unloads a thread as soon as its last subscriber
 * leaves while it is idle, so the next resume can switch its provider even
 * after a failed turn. The credits provider is defined only when this instance
 * has a Rome Cloud origin.
 */
export function codexAppServerConfigArgs(romeCloudOrigin: string | null): string[] {
  const args = ["-c", "thread_unload_delay_secs=0"];
  if (!romeCloudOrigin) return args;
  const provider = [
    `name=${tomlString("Rome credits")}`,
    `base_url=${tomlString(`${romeCloudOrigin}/v1`)}`,
    `env_key=${tomlString(ROME_CREDITS_TOKEN_ENV)}`,
    `wire_api="responses"`,
    // The gateway authenticates the instance token, not an OpenAI login.
    "requires_openai_auth=false",
    "supports_websockets=false",
    // The gateway answers 429 with `retry-after: 60`; one retry keeps a turn
    // from stalling for minutes. A replayed stream would reserve credits twice
    // while the first attempt's hold is still unresolved, so never replay it.
    "request_max_retries=1",
    "stream_max_retries=0",
  ].join(",");
  args.push("-c", `model_providers.${ROME_CREDITS_MODEL_PROVIDER_ID}={${provider}}`);
  return args;
}
