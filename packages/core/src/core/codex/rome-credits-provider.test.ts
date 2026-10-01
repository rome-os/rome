import { describe, expect, it } from "@rstest/core";
import {
  codexAppServerConfigArgs,
  ROME_CREDITS_MODEL_PROVIDER_ID,
} from "./rome-credits-provider.js";

const BASE_ARGS = [
  "-c",
  "thread_unload_delay_secs=0",
  "-c",
  'shell_environment_policy.exclude=["ROME_CREDITS_TOKEN"]',
];

describe("codexAppServerConfigArgs", () => {
  it("keeps the credential out of agent commands even without a Rome Cloud origin", () => {
    expect(codexAppServerConfigArgs(null)).toEqual(BASE_ARGS);
  });

  it("defines the credits provider against the Rome Cloud gateway", () => {
    const args = codexAppServerConfigArgs("https://romeos.cc");
    expect(args.slice(0, 4)).toEqual(BASE_ARGS);
    expect(args[4]).toBe("-c");
    const override = args[5]!;
    expect(override.startsWith(`model_providers.${ROME_CREDITS_MODEL_PROVIDER_ID}={`)).toBe(true);
    expect(override).toContain('base_url="https://romeos.cc/v1"');
    expect(override).toContain('env_key="ROME_CREDITS_TOKEN"');
    expect(override).toContain("requires_openai_auth=false");
    expect(override).toContain("stream_max_retries=0");
    expect(override).not.toContain("romeinst_");
  });
});
