import { describe, expect, it } from "@rstest/core";
import { getApiErrorMessage } from "./api-error";

function response(body: string, contentType = "application/json"): Response {
  return new Response(body, { status: 500, headers: { "Content-Type": contentType } });
}

describe("getApiErrorMessage", () => {
  it("prefers the server's structured detail", async () => {
    const message = await getApiErrorMessage(
      response(JSON.stringify({ detail: "Session expired" })),
      "fallback",
    );
    expect(message).toBe("Session expired");
  });

  it("reads message and error as well", async () => {
    expect(
      await getApiErrorMessage(response(JSON.stringify({ message: "Nope" })), "fallback"),
    ).toBe("Nope");
    expect(
      await getApiErrorMessage(response(JSON.stringify({ error: "Sync disabled" })), "fallback"),
    ).toBe("Sync disabled");
  });

  // These messages are rendered to the guardian, so a body that carries none of
  // the structured fields — an HTML error page, a stack trace, a bare string —
  // must not reach the UI verbatim.
  it("does not surface an unstructured body", async () => {
    const html = response(
      "<!doctype html><html><body>500: TypeError at handler (/srv/app.js:42)</body></html>",
      "text/html",
    );
    expect(await getApiErrorMessage(html, "Something went wrong.")).toBe("Something went wrong.");
  });

  it("falls back when the JSON carries no usable field", async () => {
    expect(await getApiErrorMessage(response(JSON.stringify({ code: 17 })), "fallback")).toBe(
      "fallback",
    );
    expect(await getApiErrorMessage(response(JSON.stringify({ detail: "   " })), "fallback")).toBe(
      "fallback",
    );
  });
});
