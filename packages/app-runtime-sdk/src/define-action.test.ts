import { describe, it, expect } from "@rstest/core";
import { defineAction, z, type ActionConfig } from "./index.js";

const config: ActionConfig = {
  name: "demo",
  type: "system",
  description: "demo action",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
};

describe("defineAction", () => {
  it("preserves action visibility metadata", () => {
    const action = defineAction({
      config: { ...config, visibility: "explicit" },
      schema: z.object({}),
      execute: async () => ({ status: "ok" }) as const,
    });

    expect(action.config.visibility).toBe("explicit");
  });

  it("derives a model-facing JSON schema without the $schema dialect key", () => {
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async () => ({ status: "ok" }) as const,
    });

    expect(action.inputSchema).not.toHaveProperty("$schema");
    expect(action.inputSchema).toMatchObject({
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    });
  });

  it("execute returns an error result and skips the handler on invalid input", async () => {
    let handlerRan = false;
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async () => {
        handlerRan = true;
        return { status: "ok" } as const;
      },
    });

    const result = await action.execute({});

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/Invalid input for demo/);
    expect(handlerRan).toBe(false);
  });

  it("execute receives parsed input with unknown keys stripped on valid args", async () => {
    let seen: unknown;
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async (input) => {
        seen = input;
        return { status: "ok" } as const;
      },
    });

    const result = await action.execute({ x: "hi", extra: "dropped" });

    expect(result.status).toBe("ok");
    expect(seen).toEqual({ x: "hi" });
  });

  it("passes the Action execution context to a valid handler", async () => {
    const emitted: unknown[] = [];
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async (_input, context) => {
        context.emitActionEvent({ type: "started", value: 1 });
        return { status: "ok" } as const;
      },
    });

    await action.execute(
      { x: "hi" },
      {
        emitActionEvent(event) {
          emitted.push(event);
        },
      },
    );

    expect(emitted).toEqual([{ type: "started", value: 1 }]);
  });

  it("preview returns an Invalid input card instead of throwing on invalid input", () => {
    let rendererRan = false;
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async () => ({ status: "ok" }) as const,
      preview: () => {
        rendererRan = true;
        return { kind: "generic", title: "rendered", summary: "" };
      },
    });

    const payload = action.preview!({});

    expect(payload).toEqual({
      kind: "generic",
      title: "Invalid input",
      summary: expect.stringMatching(/Invalid input for demo/),
    });
    expect(rendererRan).toBe(false);
  });

  it("preview receives parsed input on valid args", () => {
    let seen: unknown;
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async () => ({ status: "ok" }) as const,
      preview: (input) => {
        seen = input;
        return { kind: "generic", title: "rendered", summary: "" };
      },
    });

    action.preview!({ x: "hi", extra: "dropped" });

    expect(seen).toEqual({ x: "hi" });
  });

  it("omits preview entirely when no renderer is provided", () => {
    const action = defineAction({
      config,
      schema: z.object({ x: z.string() }),
      execute: async () => ({ status: "ok" }) as const,
    });

    expect(action.preview).toBeUndefined();
  });
});

describe("defineAction routine trigger payload", () => {
  async function seenInput(schema: z.ZodType, args: Record<string, unknown>) {
    let seen: unknown;
    const action = defineAction({
      config,
      schema,
      execute: async (input) => {
        seen = input;
        return { status: "ok" } as const;
      },
    });
    const result = await action.execute(args);
    return { result, seen };
  }

  it("lets a strict schema run under a routine that adds __triggerPayload", async () => {
    const { result, seen } = await seenInput(z.strictObject({ x: z.string() }), {
      x: "hi",
      __triggerPayload: {},
    });

    expect(result.status).toBe("ok");
    expect(seen).toEqual({ x: "hi" });
  });

  it("still rejects other unknown keys on a strict schema", async () => {
    const { result } = await seenInput(z.strictObject({ x: z.string() }), {
      x: "hi",
      extra: 1,
    });

    expect(result.status).toBe("error");
  });

  it("passes __triggerPayload to a schema that declares it", async () => {
    const { seen } = await seenInput(
      z.strictObject({ x: z.string(), __triggerPayload: z.unknown().optional() }),
      { x: "hi", __triggerPayload: { id: 1 } },
    );

    expect(seen).toEqual({ x: "hi", __triggerPayload: { id: 1 } });
  });

  it("passes __triggerPayload to a loose schema", async () => {
    const { seen } = await seenInput(z.looseObject({ x: z.string() }), {
      x: "hi",
      __triggerPayload: { id: 1 },
    });

    expect(seen).toEqual({ x: "hi", __triggerPayload: { id: 1 } });
  });
});
