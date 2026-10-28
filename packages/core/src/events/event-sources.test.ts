import { describe, expect, it, rs } from "@rstest/core";
import { EventSources, type DeclaredEventSource, type RunEnsureAction } from "./event-sources.js";

const github: DeclaredEventSource = {
  appId: "connector",
  events: "provider:event:github.*",
  keys: [["repository.full_name"], ["organization.login"]],
  types: ["push", "workflow_run"],
  ensureAction: "connector_event_ensure",
};

const REPO_FILTER = [{ field: "repository.full_name", equals: "acme/widgets" }];

function sources(known: string[] = [], list: DeclaredEventSource[] = [github]) {
  return new EventSources({
    listSources: () => list,
    isKnownEventType: (name) => known.includes(name),
  });
}

describe("EventSources", () => {
  it("finds the source whose events glob matches", () => {
    expect(sources().sourceFor("provider:event:github.workflow_run")?.appId).toBe("connector");
    expect(sources().sourceFor("provider:event:gmail.new")).toBeUndefined();
  });

  it("lists one subscribable entry per declared type", () => {
    expect(sources().declaredEntries()).toEqual([
      {
        eventType: "provider:event:github.push",
        appId: "connector",
        subscribable: true,
        keys: github.keys,
      },
      {
        eventType: "provider:event:github.workflow_run",
        appId: "connector",
        subscribable: true,
        keys: github.keys,
      },
    ]);
  });

  describe("prepareWait", () => {
    it("calls the ensure action and returns its subscription", async () => {
      const run = rs.fn<RunEnsureAction>(async () => ({
        status: "ok",
        data: { subscription: "created" },
      }));
      const result = await sources().prepareWait(
        "provider:event:github.workflow_run",
        REPO_FILTER,
        run,
      );
      expect(result).toEqual({ ok: true, subscription: "created" });
      expect(run).toHaveBeenCalledWith("connector_event_ensure", {
        eventName: "provider:event:github.workflow_run",
        filter: REPO_FILTER,
        dryRun: false,
      });
    });

    it("refuses a filter that names no subscription target, without calling the action", async () => {
      const run = rs.fn<RunEnsureAction>();
      const result = await sources().prepareWait(
        "provider:event:github.workflow_run",
        [{ field: "action", equals: "completed" }],
        run,
      );
      expect(result).toEqual({
        ok: false,
        error:
          "provider:event:github.workflow_run needs a filter on repository.full_name or organization.login",
      });
      expect(run).not.toHaveBeenCalled();
    });

    it("needs no filter when the source declares no keys", async () => {
      const run = rs.fn<RunEnsureAction>(async () => ({
        status: "ok",
        data: { subscription: "existing" },
      }));
      const list = [{ ...github, keys: [] }];
      const result = await sources([], list).prepareWait("provider:event:github.push", [], run);
      expect(result).toEqual({ ok: true, subscription: "existing" });
    });

    it("passes on the action's error", async () => {
      const run = rs.fn<RunEnsureAction>(async () => ({
        status: "error",
        error: "GitHub refused the webhook on acme/widgets",
      }));
      const result = await sources().prepareWait("provider:event:github.push", REPO_FILTER, run);
      expect(result).toEqual({ ok: false, error: "GitHub refused the webhook on acme/widgets" });
    });

    it("turns a thrown action into a readable error", async () => {
      const run = rs.fn<RunEnsureAction>(async () => {
        throw new Error('Action "connector_event_ensure" not found');
      });
      const result = await sources().prepareWait("provider:event:github.push", REPO_FILTER, run);
      expect(result).toEqual({
        ok: false,
        error: 'connector_event_ensure failed: Action "connector_event_ensure" not found',
      });
    });

    it("rejects a subscription state outside the contract", async () => {
      const run = rs.fn<RunEnsureAction>(async () => ({
        status: "ok",
        data: { subscription: "active" },
      }));
      const result = await sources().prepareWait("provider:event:github.push", REPO_FILTER, run);
      expect(result.ok).toBe(false);
    });

    it("accepts an undeclared event, with a warning when nothing has emitted it", async () => {
      const run = rs.fn<RunEnsureAction>();
      expect(await sources(["test.ci.done"]).prepareWait("test.ci.done", [], run)).toEqual({
        ok: true,
      });
      const unseen = await sources().prepareWait("provider:event:gmail.new_message", [], run);
      expect(unseen.ok).toBe(true);
      if (unseen.ok) expect(unseen.warning).toContain("search_event_catalog");
      expect(run).not.toHaveBeenCalled();
    });

    it("runs one subscribing call per source at a time", async () => {
      // Each call reads the shared list, yields, then writes it back, like a
      // webhook update. Run concurrently, the second write would drop the first.
      let hookEvents: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const run = rs.fn<RunEnsureAction>(async (_name, args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const read = [...hookEvents];
        await new Promise((resolve) => setTimeout(resolve, 5));
        hookEvents = [...read, String(args.eventName)];
        inFlight -= 1;
        return { status: "ok", data: { subscription: "created" } };
      });
      const s = sources();
      await Promise.all([
        s.prepareWait("provider:event:github.workflow_run", REPO_FILTER, run),
        s.prepareWait("provider:event:github.push", REPO_FILTER, run),
      ]);
      expect(maxInFlight).toBe(1);
      expect(hookEvents.sort()).toEqual([
        "provider:event:github.push",
        "provider:event:github.workflow_run",
      ]);
    });

    it("keeps the queue moving after a failed call", async () => {
      const run = rs
        .fn<RunEnsureAction>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ status: "ok", data: { subscription: "existing" } });
      const s = sources();
      const [first, second] = await Promise.all([
        s.prepareWait("provider:event:github.push", REPO_FILTER, run),
        s.prepareWait("provider:event:github.push", REPO_FILTER, run),
      ]);
      expect(first.ok).toBe(false);
      expect(second).toEqual({ ok: true, subscription: "existing" });
    });
  });

  describe("probe", () => {
    it("asks in dry-run mode and reports whether the subscription is active", async () => {
      const run = rs.fn<RunEnsureAction>(async () => ({
        status: "ok",
        data: { subscription: "active" },
      }));
      const result = await sources().probe("provider:event:github.push", REPO_FILTER, run);
      expect(result).toEqual({ ok: true, active: true });
      expect(run).toHaveBeenCalledWith("connector_event_ensure", {
        eventName: "provider:event:github.push",
        filter: REPO_FILTER,
        dryRun: true,
      });
    });
  });
});
