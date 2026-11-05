import { describe, expect, it, rs } from "@rstest/core";

import { forgetActiveTriggers, keptActiveTriggers } from "./active-triggers.js";

describe("keptActiveTriggers", () => {
  it("reads the project's triggers once per five minutes, and again after one is armed", async () => {
    forgetActiveTriggers();
    const listActiveTriggers = rs.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const client = { listActiveTriggers };
    await keptActiveTriggers(client, 0);
    await keptActiveTriggers(client, 4 * 60_000);
    expect(listActiveTriggers).toHaveBeenCalledTimes(1);
    forgetActiveTriggers();
    await keptActiveTriggers(client, 4 * 60_000 + 1);
    expect(listActiveTriggers).toHaveBeenCalledTimes(2);
  });

  it("keeps no failed read", async () => {
    forgetActiveTriggers();
    const listActiveTriggers = rs
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([]);
    const client = { listActiveTriggers };
    await expect(keptActiveTriggers(client, 0)).rejects.toThrow("fetch failed");
    await expect(keptActiveTriggers(client, 1)).resolves.toEqual([]);
  });
});
