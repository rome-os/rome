import { describe, expect, it } from "@rstest/core";
import { checkSnapshotName } from "./stack.js";

describe("checkSnapshotName", () => {
  it("takes a plain name", () => {
    for (const name of ["frozen", "before-2", "v1.2_b"])
      expect(() => checkSnapshotName(name)).not.toThrow();
  });

  it("refuses any name that leaves the snapshots folder", () => {
    for (const name of [".", "..", "../default", "a/b", "/abs", "", ".hidden", "a..b", "-x"])
      expect(() => checkSnapshotName(name)).toThrow(/bad snapshot name/);
  });
});
