import { describe, expect, it } from "@rstest/core";
import { resolve } from "node:path";
import { copyRequest, parseLocation } from "./copy.js";

const A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const B = "16fd2706-8baf-433b-82eb-8c7fada847da";
const cwd = resolve("/work/dir");

describe("rome-node cp arguments", () => {
  it("parses device paths and leaves everything else local", () => {
    expect(parseLocation(`${A.toUpperCase()}:/tmp/a b`)).toEqual({ deviceId: A, path: "/tmp/a b" });
    expect(parseLocation(`${A}:C:/Users/x`)).toEqual({ deviceId: A, path: "C:/Users/x" });
    expect(parseLocation("C:/Users/x")).toEqual({ path: "C:/Users/x" });
    expect(parseLocation("not-a-device:/x")).toEqual({ path: "not-a-device:/x" });
    expect(() => parseLocation(`${A}:`)).toThrow("path is required");
  });

  it("maps local to device as a push with an absolute local path", () => {
    expect(copyRequest("video.mp4", `${A}:/tmp/v.mp4`, cwd)).toEqual({
      direction: "push",
      localPath: resolve(cwd, "video.mp4"),
      deviceId: A,
      remotePath: "/tmp/v.mp4",
    });
  });

  it("maps device to local as a pull and keeps relative device paths", () => {
    expect(copyRequest(`${A}:clips/v.mp4`, "../out.mp4", cwd)).toEqual({
      direction: "pull",
      localPath: resolve(cwd, "../out.mp4"),
      deviceId: A,
      remotePath: "clips/v.mp4",
    });
  });

  it("appends the source file name to a destination ending in a separator", () => {
    expect(copyRequest("media/it's $v.mp4", `${A}:/tmp/`, cwd).remotePath).toBe("/tmp/it's $v.mp4");
    expect(copyRequest(`${A}:C:\\Users\\me\\v.mp4`, "downloads/", cwd).localPath).toBe(
      resolve(cwd, "downloads", "v.mp4"),
    );
    expect(copyRequest("v.mp4", `${A}:C:\\Users\\me\\`, cwd).remotePath).toBe(
      "C:\\Users\\me\\v.mp4",
    );
  });

  it("rejects two device paths and two local paths", () => {
    expect(() => copyRequest(`${A}:/a`, `${B}:/b`, cwd)).toThrow("two steps through this computer");
    expect(() => copyRequest("a", "b", cwd)).toThrow("One side must be a device path");
  });
});
