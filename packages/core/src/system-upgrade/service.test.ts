import { describe, it, expect, rs } from "@rstest/core";
import { SystemUpgradeService } from "./service.js";
import type { ApplyResult, CheckResult, UpgradeCheck } from "./rome-cloud-client.js";

function check(
  data: Partial<UpgradeCheck> & Pick<UpgradeCheck, "upgradeAvailable" | "latest">,
): CheckResult {
  return { ok: true, data: { current: { version: "1.0.0", sha: null }, ...data } };
}

function makeService(
  opts: {
    checkUpgrade?: () => Promise<CheckResult>;
    applyUpgrade?: (target: string) => Promise<ApplyResult>;
    isEnabled?: () => Promise<boolean>;
  } = {},
) {
  const applyUpgrade = opts.applyUpgrade ?? rs.fn(async () => ({ ok: true }) as ApplyResult);
  // Countdown timers are captured rather than armed, so a test can fire the
  // deadline path deterministically.
  const timers: (() => void)[] = [];
  const service = new SystemUpgradeService({
    countdownMs: 600_000,
    isEnabled: opts.isEnabled,
    checkUpgrade:
      opts.checkUpgrade ?? (async () => ({ ok: false, error: "pantheon_unconfigured" })),
    applyUpgrade,
    setTimeout: (fn) => {
      timers.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
  });
  const fireDeadline = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return { service, applyUpgrade, fireDeadline };
}

describe("SystemUpgradeService.checkAndOffer", () => {
  it("offers nothing when no release is pending", async () => {
    const { service } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: false, latest: { version: "1.0.0" } }),
    });
    const result = await service.checkAndOffer();
    expect(result.pending).toBe(false);
    expect(service.getHub().getSnapshot().phase).toBe("idle");
  });

  it("stands down without probing when the auto_upgrade gate is off", async () => {
    const checkUpgrade = rs.fn(async () =>
      check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
    );
    const { service } = makeService({ isEnabled: async () => false, checkUpgrade });
    const result = await service.checkAndOffer();
    expect(result.pending).toBe(false);
    expect(checkUpgrade).not.toHaveBeenCalled(); // gate short-circuits before Rome Cloud
    expect(service.getHub().getSnapshot().phase).toBe("idle");
  });

  it("opens the countdown when a release is pending", async () => {
    const { service } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
    });
    const result = await service.checkAndOffer();
    expect(result).toEqual({ pending: true, targetVersion: "1.3.0" });
    const snap = service.getHub().getSnapshot();
    expect(snap.phase).toBe("countdown");
    expect(snap.targetVersion).toBe("1.3.0");
  });

  it("is idempotent: a re-fire while a countdown is live does not re-check or reset", async () => {
    const checkUpgrade = rs.fn(async () =>
      check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
    );
    const { service } = makeService({ checkUpgrade });
    await service.checkAndOffer();
    const deadline = service.getHub().getSnapshot().deadline;
    const second = await service.checkAndOffer();
    expect(second).toEqual({ pending: true, targetVersion: "1.3.0" });
    expect(checkUpgrade).toHaveBeenCalledTimes(1); // not re-checked
    expect(service.getHub().getSnapshot().deadline).toBe(deadline);
  });

  it("stands down when the Rome Cloud check is unavailable", async () => {
    const { service } = makeService({
      checkUpgrade: async () => ({ ok: false, error: "pantheon_unreachable" }),
    });
    expect((await service.checkAndOffer()).pending).toBe(false);
    expect(service.getHub().getSnapshot().phase).toBe("idle");
  });

  it("stands down when the check throws", async () => {
    const { service } = makeService({
      checkUpgrade: async () => {
        throw new Error("boom");
      },
    });
    expect((await service.checkAndOffer()).pending).toBe(false);
    expect(service.getHub().getSnapshot().phase).toBe("idle");
  });
});

describe("SystemUpgradeService cutover", () => {
  it("update now relays to Rome Cloud and only acks after acceptance", async () => {
    const { service, applyUpgrade } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
    });
    await service.checkAndOffer();
    const result = await service.requestNow();
    expect(result).toEqual({ ok: true });
    expect(applyUpgrade).toHaveBeenCalledExactlyOnceWith("1.3.0");
    expect(service.getHub().getSnapshot().phase).toBe("updating");
  });

  it("update now surfaces a failed relay and leaves the countdown standing", async () => {
    const { service } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade: async () => ({ ok: false, error: "pantheon_unreachable" }),
    });
    await service.checkAndOffer();
    const result = await service.requestNow();
    expect(result).toEqual({ ok: false, error: "pantheon_unreachable" });
    // The deadline stays armed, so the cutover still retries on silence and
    // the guardian can press the button again.
    expect(service.getHub().getSnapshot().phase).toBe("countdown");
    expect(service.getHub().getSnapshot().targetVersion).toBe("1.3.0");
  });

  it("update now outside a countdown is an ok no-op", async () => {
    const { service, applyUpgrade } = makeService();
    const result = await service.requestNow();
    expect(result).toEqual({ ok: true });
    expect(applyUpgrade).not.toHaveBeenCalled();
    expect(service.getHub().getSnapshot().phase).toBe("idle");
  });

  it("the elapsed deadline relays on silence and marks the restart", async () => {
    const { service, applyUpgrade, fireDeadline } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
    });
    await service.checkAndOffer();
    fireDeadline();
    await rs.waitFor(() => expect(service.getHub().getSnapshot().phase).toBe("updating"));
    expect(applyUpgrade).toHaveBeenCalledExactlyOnceWith("1.3.0");
  });

  it("a failed deadline-path relay stands down to idle for the next nightly re-offer", async () => {
    const { service, fireDeadline } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade: async () => ({ ok: false, error: "pantheon_unreachable" }),
    });
    await service.checkAndOffer();
    fireDeadline();
    await rs.waitFor(() => expect(service.getHub().getSnapshot().phase).toBe("idle"));
    expect(service.getHub().getSnapshot().targetVersion).toBeNull();
  });

  it("a deadline firing during an in-flight relay does not double-apply", async () => {
    let release!: (result: ApplyResult) => void;
    const applyUpgrade = rs.fn(() => new Promise<ApplyResult>((resolve) => (release = resolve)));
    const { service, fireDeadline } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade,
    });
    await service.checkAndOffer();
    const pending = service.requestNow();
    fireDeadline();
    release({ ok: true });
    await pending;
    expect(applyUpgrade).toHaveBeenCalledTimes(1);
    expect(service.getHub().getSnapshot().phase).toBe("updating");
  });

  it("a deadline firing during a failing in-flight relay stands the offer down", async () => {
    let release!: (result: ApplyResult) => void;
    const applyUpgrade = rs.fn(() => new Promise<ApplyResult>((resolve) => (release = resolve)));
    const { service, fireDeadline } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade,
    });
    await service.checkAndOffer();
    const pending = service.requestNow();
    // The timer is spent the moment it fires — if the adopted relay then
    // fails, only a stand-down keeps the offer from being stuck in countdown
    // forever (the nightly probe no-ops on any non-idle phase).
    fireDeadline();
    release({ ok: false, error: "pantheon_unreachable" });
    expect(await pending).toEqual({ ok: false, error: "pantheon_unreachable" });
    expect(applyUpgrade).toHaveBeenCalledTimes(1);
    await rs.waitFor(() => expect(service.getHub().getSnapshot().phase).toBe("idle"));
    expect(service.getHub().getSnapshot().targetVersion).toBeNull();
  });

  it("a concurrent update now shares the in-flight relay outcome", async () => {
    let release!: (result: ApplyResult) => void;
    const applyUpgrade = rs.fn(() => new Promise<ApplyResult>((resolve) => (release = resolve)));
    const { service } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade,
    });
    await service.checkAndOffer();
    const first = service.requestNow();
    const second = service.requestNow();
    release({ ok: false, error: "pantheon_unreachable" });
    expect(await first).toEqual({ ok: false, error: "pantheon_unreachable" });
    expect(await second).toEqual({ ok: false, error: "pantheon_unreachable" });
    expect(applyUpgrade).toHaveBeenCalledTimes(1);
  });

  it("a concurrent update now shares an accepted relay's ack", async () => {
    let release!: (result: ApplyResult) => void;
    const applyUpgrade = rs.fn(() => new Promise<ApplyResult>((resolve) => (release = resolve)));
    const { service } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade,
    });
    await service.checkAndOffer();
    const first = service.requestNow();
    const second = service.requestNow();
    release({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(applyUpgrade).toHaveBeenCalledTimes(1);
    expect(service.getHub().getSnapshot().phase).toBe("updating");
  });

  it("defer is a no-op while a cutover relay is in flight", async () => {
    let release!: (result: ApplyResult) => void;
    const applyUpgrade = rs.fn(() => new Promise<ApplyResult>((resolve) => (release = resolve)));
    const { service } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
      applyUpgrade,
    });
    await service.checkAndOffer();
    const pending = service.requestNow();
    // Rome Cloud may already be committing the apply — a defer here must not
    // reset the hub, or the acceptance below would be recorded against idle
    // and silently dropped.
    service.requestDefer();
    expect(service.getHub().getSnapshot().phase).toBe("countdown");
    release({ ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(service.getHub().getSnapshot().phase).toBe("updating");
  });

  it("defer tears the countdown down without relaying", async () => {
    const { service, applyUpgrade } = makeService({
      checkUpgrade: async () => check({ upgradeAvailable: true, latest: { version: "1.3.0" } }),
    });
    await service.checkAndOffer();
    service.requestDefer();
    expect(service.getHub().getSnapshot().phase).toBe("idle");
    expect(applyUpgrade).not.toHaveBeenCalled();
  });
});
