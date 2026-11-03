import { describe, expect, it, rs } from "@rstest/core";
import { EventCatalog } from "../event-catalog.js";
import { EventBus } from "./event-bus.js";
import { EventService } from "./event-service.js";
import { EventSources, type RunEnsureAction } from "./event-sources.js";

const KEYS = [["repository.full_name"], ["organization.login"]];

function setup(run: RunEnsureAction = rs.fn<RunEnsureAction>()) {
  const catalog = new EventCatalog();
  const sources = new EventSources({
    listSources: () => [
      {
        appId: "connector",
        events: "provider:event:github.*",
        keys: KEYS,
        types: ["push", "workflow_run"],
        ensureAction: "connector_event_ensure",
      },
    ],
    isKnownEventType: (name) => catalog.get(name) !== undefined,
  });
  const service = new EventService(new EventBus(), catalog, { sources, run });
  return { service, run };
}

describe("EventService.search", () => {
  it("lists declared types before they are emitted, without calling a provider", async () => {
    const { service, run } = setup();
    const { entries, total } = await service.search("github", 10);
    expect(total).toBe(2);
    expect(entries.map((e) => e.eventType).sort()).toEqual([
      "provider:event:github.push",
      "provider:event:github.workflow_run",
    ]);
    expect(entries.every((e) => e.subscribable && e.keys === KEYS)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the observed schema of an emitted declared type and marks it subscribable", async () => {
    const { service } = setup();
    await service.publish({
      name: "provider:event:github.push",
      source: "connector",
      payload: { ref: "refs/heads/main" },
    });
    await service.publish({ name: "test.ci.done", source: "tests", payload: { ok: true } });

    const { entries, total } = await service.search("", 10);
    expect(total).toBe(3);
    const push = entries.find((e) => e.eventType === "provider:event:github.push");
    expect(push).toMatchObject({ subscribable: true, keys: KEYS, schemaOrigin: "observed" });
    expect(push?.payloadSchema?.properties).toHaveProperty("ref");
    const internal = entries.find((e) => e.eventType === "test.ci.done");
    expect(internal?.subscribable).toBeUndefined();
  });

  it("with match, reports per subscribable type whether it is active", async () => {
    const run = rs.fn<RunEnsureAction>(async (_name, args) => ({
      status: "ok",
      data: {
        subscription: args.eventName === "provider:event:github.push" ? "active" : "inactive",
      },
    }));
    const { service } = setup(run);
    const { entries, matchError } = await service.search("github", 10, {
      match: { "repository.full_name": "acme/widgets" },
    });
    expect(matchError).toBeUndefined();
    expect(Object.fromEntries(entries.map((e) => [e.eventType, e.active]))).toEqual({
      "provider:event:github.push": true,
      "provider:event:github.workflow_run": false,
    });
    expect(run).toHaveBeenCalledWith("connector_event_ensure", {
      eventName: "provider:event:github.push",
      filter: [{ field: "repository.full_name", equals: "acme/widgets" }],
      dryRun: true,
    });
  });

  it("stops probing after the first failure", async () => {
    const run = rs.fn<RunEnsureAction>(async () => ({
      status: "error",
      error: "github is managed by Rome — connect it in Settings",
    }));
    const { service } = setup(run);
    const { entries, matchError } = await service.search("github", 10, {
      match: { "repository.full_name": "acme/widgets" },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(matchError).toBe("github is managed by Rome — connect it in Settings");
    expect(entries.every((e) => e.active === undefined)).toBe(true);
  });

  it("with a match the source cannot use, leaves active unset and says why", async () => {
    const { service, run } = setup();
    const { entries, matchError } = await service.search("github", 10, {
      match: { "sender.login": "octocat" },
    });
    expect(entries.every((e) => e.active === undefined)).toBe(true);
    expect(matchError).toContain("needs a filter on repository.full_name");
    expect(run).not.toHaveBeenCalled();
  });
});
