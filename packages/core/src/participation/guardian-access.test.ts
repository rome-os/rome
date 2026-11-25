import { describe, expect, it } from "@rstest/core";
import { actsWithGuardianAccess } from "./guardian-access.js";

describe("who acts with the guardian's access", () => {
  it("is the guardian, and anyone an account that serves its workspace hears", () => {
    expect(actsWithGuardianAccess({ servesWorkspace: false, guardian: true })).toBe(true);
    expect(actsWithGuardianAccess({ servesWorkspace: true, guardian: false })).toBe(true);
    expect(actsWithGuardianAccess({ servesWorkspace: false, guardian: false })).toBe(false);
  });
});
