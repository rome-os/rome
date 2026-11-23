import { describe, expect, it } from "@rstest/core";
import { isStopRequest } from "./stop-request.js";

describe("isStopRequest", () => {
  it("reads /stop alone or after mentions as a stop", () => {
    expect(isStopRequest("/stop")).toBe(true);
    expect(isStopRequest(" /STOP ")).toBe(true);
    expect(isStopRequest("@Rome /stop")).toBe(true);
    expect(isStopRequest("@Rome @Grace Hopper /stop")).toBe(true);
  });

  it("reads anything else as a message", () => {
    expect(isStopRequest(undefined)).toBe(false);
    expect(isStopRequest("please /stop")).toBe(false);
    expect(isStopRequest("@Rome /stop now")).toBe(false);
    expect(isStopRequest("@Rome stop")).toBe(false);
  });
});
