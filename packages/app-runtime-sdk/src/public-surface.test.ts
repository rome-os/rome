import { describe, expect, it } from "@rstest/core";
import * as sdk from "./index.js";

// The published SDK carries zero IPC vocabulary, so an app cannot
// take a dependency on process topology. If a transport primitive ever leaks
// back onto this surface, this pins the regression at the export site.
describe("public surface", () => {
  it("exports no RPC/IPC transport primitives", () => {
    const transportish = Object.keys(sdk).filter((name) =>
      /workerrpc|ipcrpc|workeripc|proxy/i.test(name),
    );
    expect(transportish).toEqual([]);
  });

  it("exports the uniform invocation error with its wire-stable fields", () => {
    const err = new sdk.ActionInvocationError("send_message", "not_found", "no such action");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ActionInvocationError");
    expect(err.actionName).toBe("send_message");
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("no such action");
  });
});
