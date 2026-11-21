import { describe, expect, it, rs } from "@rstest/core";
import { createPublishEventAction } from "../../../../rome_apps/system/src/actions/publish-event/index.js";
import { ActionEngine } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { EventCatalog } from "../event-catalog.js";
import { EventBus } from "../events/event-bus.js";
import { EventService } from "../events/event-service.js";
import { systemClock } from "../lib/clock.js";
import { RoutineEngine } from "../routines/engine.js";
import { EventBusTriggerProvider } from "../routines/event-bus-trigger-provider.js";
import { createActionEngineRepos, createTestDb } from "../test/db.js";
import { buildAction, recordingAction } from "../test/kit/index.js";

describe("system:publish_event as a coordination root", () => {
  it("publishes from main, and a routine it fires runs as its own root", async () => {
    const { db } = createTestDb();
    const bus = new EventBus();
    const registry = new ActionRegistryImpl();
    registry.register(
      createPublishEventAction(
        { ...buildAction("system:publish_event").config, sideEffects: "write" },
        "system",
        { eventBus: new EventService(bus, new EventCatalog()) },
      ),
    );
    // The routine's target is itself a coordination root, so it too runs in
    // main. Fired from inside publish_event's context, it would be a nested
    // call, which the engine refuses for a coordination root.
    const target = recordingAction("system:send_message", { type: "system" });
    registry.register(target.action);
    const actionWorkerFork = rs.fn(() => {
      throw new Error("no worker expected");
    });
    const engine = new ActionEngine(registry, createActionEngineRepos(db), {
      processRole: "main",
      workerWarmPoolSize: 0,
      actionWorkerFork,
      isFirstPartyAction: () => true,
    });

    const routinesRepo = new RoutinesRepository(db);
    const routineRuns = new RoutineRunsRepository(db);
    const routineEngine = new RoutineEngine(routinesRepo, routineRuns, engine, 0, systemClock);
    const provider = new EventBusTriggerProvider(bus, routinesRepo);
    routineEngine.registerProvider("event-bus", provider);
    const routineId = await routinesRepo.create({
      name: "on order",
      trigger: { type: "event-bus", eventName: "order.created" },
      actionName: "system:send_message",
      args: {},
    });
    const row = await routinesRepo.findById(routineId);
    if (!row) throw new Error("routine not stored");
    await routineEngine.activate(toRoutine(row));

    await expect(
      engine.run("system:publish_event", { name: "order.created", payload: { id: 7 } }),
    ).resolves.toMatchObject({ status: "ok", data: { accepted: true } });

    // The fire is detached from the publish: wait for its run to settle.
    const deadline = Date.now() + 5_000;
    let runs = await routineRuns.findByRoutineId(routineId);
    while ((runs.length === 0 || runs[0]?.status === "running") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      runs = await routineRuns.findByRoutineId(routineId);
    }
    expect(runs.map((run) => run.status)).toEqual(["success"]);
    expect(target.calls).toHaveLength(1);
    expect(actionWorkerFork).not.toHaveBeenCalled();
    provider.stop();
  });
});
