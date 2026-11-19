import { afterEach, describe, expect, it } from "@rstest/core";
import { setGateOverride } from "@rome-os/libs/feature-flags";
import { resetFeatureGates, useFakeFeatureGates } from "@rome-os/libs/feature-flags/testing";
import { resolveFeatureVisibility } from "./feature-visibility.js";

const originalSlug = process.env.PANTHEON_SLUG;

afterEach(async () => {
  if (originalSlug === undefined) delete process.env.PANTHEON_SLUG;
  else process.env.PANTHEON_SLUG = originalSlug;
  await resetFeatureGates();
});

describe("resolveFeatureVisibility", () => {
  it("hides every gated feature when no gate is on", async () => {
    useFakeFeatureGates();
    process.env.PANTHEON_SLUG = "inst-42";
    expect(await resolveFeatureVisibility()).toEqual({
      people: false,
      envoys: false,
      inbox: false,
    });
  });

  it("shows a feature whose gate is on for the instance slug", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("people", "inst-42");
    process.env.PANTHEON_SLUG = "inst-42";
    expect(await resolveFeatureVisibility()).toEqual({
      people: true,
      envoys: false,
      inbox: false,
    });
  });

  it("hides every gated feature when the gate backend cannot answer", async () => {
    const gates = useFakeFeatureGates();
    gates.enable("inbox");
    gates.breakBackend();
    process.env.PANTHEON_SLUG = "inst-42";
    expect((await resolveFeatureVisibility()).inbox).toBe(false);
  });

  it("shows a feature an override forces on, on an instance with no slug", async () => {
    delete process.env.PANTHEON_SLUG;
    setGateOverride("envoys", true);
    expect((await resolveFeatureVisibility()).envoys).toBe(true);
  });
});
