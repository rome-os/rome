import { describe, expect, it } from "@rstest/core";
import { buildCallbackResponse } from "./callback-response.js";

describe("buildCallbackResponse", () => {
  it("redirects a dashboard-initiated connect back to the connector dashboard", () => {
    const res = buildCallbackResponse("dashboard", "gmail", true);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/apps/connector?connector=gmail&status=ACTIVE");
  });

  it("carries a failed dashboard result through the redirect status", () => {
    const res = buildCallbackResponse("dashboard", "slack", false);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/apps/connector?connector=slack&status=failed");
  });

  it("lands a webchat-initiated connect on a terminal page, not the dashboard", async () => {
    const res = buildCallbackResponse("webchat", "gmail", true);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Connected");
    expect(html).toContain("return to your chat");
    expect(html).not.toContain("/apps/connector");
  });

  it("tells a webchat user a failed connect to retry, still off the dashboard", async () => {
    const res = buildCallbackResponse("webchat", "slack", false);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Couldn't connect");
    expect(html).not.toContain("/apps/connector");
  });
});
