import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { startExpiringCredentialRenewal } from "./expiring-renewal.js";

describe("startExpiringCredentialRenewal", () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  it("runs a pass at once, then one per interval", async () => {
    rs.useFakeTimers();
    const renewExpiring = rs.fn(async (_withinMs: number) => {});
    const stop = startExpiringCredentialRenewal(
      { renewExpiring },
      { intervalMs: 1_000, windowMs: 2_000 },
    );

    expect(renewExpiring).toHaveBeenCalledTimes(1);
    expect(renewExpiring).toHaveBeenCalledWith(2_000);

    await rs.advanceTimersByTimeAsync(1_000);
    expect(renewExpiring).toHaveBeenCalledTimes(2);

    stop();
    await rs.advanceTimersByTimeAsync(5_000);
    expect(renewExpiring).toHaveBeenCalledTimes(2);
  });
});
