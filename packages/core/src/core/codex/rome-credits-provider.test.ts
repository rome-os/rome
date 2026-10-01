import { describe, expect, it } from "@rstest/core";
import {
  codexAppServerConfigArgs,
  ROME_CREDITS_MODEL_PROVIDER_ID,
} from "./rome-credits-provider.js";

describe("codexAppServerConfigArgs", () => {
  it("only zeroes the unload delay when the instance has no Rome Cloud origin", () => {
    expect(codexAppServerConfigArgs(null)).toEqual(["-c", "thread_unload_delay_secs=0"]);
  });

  it("defines the credits provider against the Rome Cloud gateway", () => {
    const args = codexAppServerConfigArgs("https://romeos.cc");
    expect(args.slice(0, 2)).toEqual(["-c", "thread_unload_delay_secs=0"]);
    expect(args[2]).toBe("-c");
    const override = args[3]!;
    expect(override.startsWith(`model_providers.${ROME_CREDITS_MODEL_PROVIDER_ID}={`)).toBe(true);
    expect(override).toContain('base_url="https://romeos.cc/v1"');
    expect(override).toContain('env_key="ROME_CREDITS_TOKEN"');
    expect(override).toContain("requires_openai_auth=false");
    expect(override).toContain("stream_max_retries=0");
    expect(override).not.toContain("romeinst_");
  });
});
