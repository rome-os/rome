// The Rome credits model provider on the shared `codex app-server`.
//
// Rome credits are an account-wide allowance Rome Cloud serves through its
// Responses-compatible inference gateway at `<Rome Cloud origin>/v1`. The one
// shared app-server knows two providers: its default (the guardian's own
// OpenAI login) and `rome_credits`. Rome restarts the app-server immediately
// when the payer changes, so each Codex process has one payer.

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
 * The credits provider is defined only when this instance has a Rome Cloud
 * origin. `defaultProvider` selects this Codex process's payer; null retains
 * Codex's normal OpenAI-login default.
 *
 * Codex keeps `*TOKEN*` variables in agent shell commands by default, so the
 * instance credential is excluded from the shell env explicitly. This is not
 * a security boundary: a full-access agent command runs as the same user and
 * can still read the app-server's environ, as it can read Rome's settings DB.
 */
export function codexAppServerConfigArgs(
  romeCloudOrigin: string | null,
  defaultProvider: string | null = null,
): string[] {
  const args = ["-c", `shell_environment_policy.exclude=[${tomlString(ROME_CREDITS_TOKEN_ENV)}]`];
  if (!romeCloudOrigin) {
    if (defaultProvider) throw new Error("Rome credits cannot be the default without Rome Cloud");
    return args;
  }
  if (defaultProvider) args.push("-c", `model_provider=${tomlString(defaultProvider)}`);
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
