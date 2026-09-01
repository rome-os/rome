import { describe, expect, it } from "@rstest/core";
import {
  createWidgetInstanceSession,
  parseWidgetInstanceSession,
} from "./widget-instance-session.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const ORIGIN = "https://ray.romeos.cc";
const SESSION = {
  cookieName: "rome_session" as const,
  origin: ORIGIN,
  token: "signed.guardian.session",
  expiresAt: "2026-09-15T12:00:00.000Z",
};

describe("Widget instance session", () => {
  it("copies only the selected, unexpired instance session", () => {
    expect(createWidgetInstanceSession(SESSION, NOW)).toEqual({ version: 1, ...SESSION });
    expect(
      createWidgetInstanceSession({ ...SESSION, origin: `${ORIGIN}/dashboard` }, NOW),
    ).toBeNull();
    expect(
      createWidgetInstanceSession({ ...SESSION, expiresAt: new Date(NOW).toISOString() }, NOW),
    ).toBeNull();
  });

  it("parses only an exact HTTPS origin and rome_session cookie", () => {
    expect(parseWidgetInstanceSession(JSON.stringify({ version: 1, ...SESSION }))).toEqual({
      version: 1,
      ...SESSION,
    });
    expect(
      parseWidgetInstanceSession(
        JSON.stringify({ version: 1, ...SESSION, cookieName: "rome_visitor" }),
      ),
    ).toBeNull();
    expect(
      parseWidgetInstanceSession(JSON.stringify({ version: 1, ...SESSION, token: "bad\nvalue" })),
    ).toBeNull();
  });
});
