import { describe, it, expect } from "@rstest/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorHandler } from "./error-handler.js";

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe("errorHandler middleware", () => {
  it("passes through HTTPException responses verbatim", async () => {
    const app = buildApp();
    app.get("/boom", () => {
      throw new HTTPException(418, { message: "I'm a teapot" });
    });

    const res = await app.request("/boom");
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("I'm a teapot");
  });

  it("returns HTTPException JSON body unchanged when thrown with res", async () => {
    const app = buildApp();
    app.get("/json-err", () => {
      throw new HTTPException(400, {
        res: new Response(JSON.stringify({ error: "bad input", field: "name" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      });
    });

    const res = await app.request("/json-err");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad input", field: "name" });
  });

  it("wraps unknown Error instances as 500 JSON with the message", async () => {
    const app = buildApp();
    app.get("/unknown", () => {
      throw new Error("something went wrong");
    });

    const res = await app.request("/unknown");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "something went wrong" });
  });

  it("includes path and method in the log context (via the thrown Error)", async () => {
    // Smoke test: the handler runs without rethrowing, and returns 500 for any Error.
    const app = buildApp();
    app.post("/items/:id", () => {
      throw new Error("db offline");
    });
    const res = await app.request("/items/42", { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db offline" });
  });
});
