import { describe, expect, it } from "@rstest/core";
import { codexAppServerConfigArgs } from "./rome-credits-provider.js";
import { ROME_CREDITS_MODEL_PROVIDER_ID } from "../../../../usage/funding.js";

const BASE_ARGS = [
  "-c",
  'shell_environment_policy.exclude=["ROME_CREDITS_TOKEN"]',
  "-c",
  "skills.bundled.enabled=false",
];

describe("codexAppServerConfigArgs", () => {
  it("keeps the credential out of agent commands even without a Rome Cloud origin", () => {
    expect(codexAppServerConfigArgs(null)).toEqual(BASE_ARGS);
  });

  it("defines the credits provider against core's loopback proxy", () => {
    const args = codexAppServerConfigArgs("https://romeos.cc");
    expect(args.slice(0, BASE_ARGS.length)).toEqual(BASE_ARGS);
    expect(args[BASE_ARGS.length]).toBe("-c");
    const override = args[BASE_ARGS.length + 1]!;
    expect(override.startsWith(`model_providers.${ROME_CREDITS_MODEL_PROVIDER_ID}={`)).toBe(true);
    expect(override).toContain('base_url="http://127.0.0.1:4141/_internal/rome-credits/v1"');
    expect(override).not.toContain("romeos.cc");
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
