import { describe, expect, it } from "@rstest/core";
import {
  codexAppServerConfigArgs,
  ROME_CREDITS_MODEL_PROVIDER_ID,
} from "./rome-credits-provider.js";

const BASE_ARGS = ["-c", 'shell_environment_policy.exclude=["ROME_CREDITS_TOKEN"]'];

describe("codexAppServerConfigArgs", () => {
  it("keeps the credential out of agent commands even without a Rome Cloud origin", () => {
    expect(codexAppServerConfigArgs(null)).toEqual(BASE_ARGS);
  });

  it("defines the credits provider against the Rome Cloud gateway", () => {
    const args = codexAppServerConfigArgs("https://romeos.cc");
    expect(args.slice(0, 2)).toEqual(BASE_ARGS);
    expect(args[2]).toBe("-c");
    const override = args[3]!;
    expect(override.startsWith(`model_providers.${ROME_CREDITS_MODEL_PROVIDER_ID}={`)).toBe(true);
    expect(override).toContain('base_url="https://romeos.cc/v1"');
    expect(override).toContain('env_key="ROME_CREDITS_TOKEN"');
    expect(override).toContain("requires_openai_auth=false");
    expect(override).toContain("stream_max_retries=0");
    expect(override).not.toContain("romeinst_");
  });

  it("selects credits as the process default without putting a provider on a thread", () => {
    const args = codexAppServerConfigArgs("https://romeos.cc", ROME_CREDITS_MODEL_PROVIDER_ID);
    expect(args).toContain('model_provider="rome_credits"');
  });
});
