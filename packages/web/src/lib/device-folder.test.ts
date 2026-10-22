import { describe, expect, it } from "@rstest/core";
import { childPath, deviceFolderLabel, tildePath } from "./device-folder";

describe("device folder paths", () => {
  it("shortens the home folder to ~ on POSIX and Windows", () => {
    expect(tildePath("/Users/ray", "/Users/ray")).toBe("~");
    expect(tildePath("/Users/ray/code/foo", "/Users/ray")).toBe("~/code/foo");
    expect(tildePath("/Users/rayan", "/Users/ray")).toBe("/Users/rayan");
    expect(tildePath("C:\\Users\\ray\\code", "C:\\Users\\ray")).toBe("~\\code");
    expect(tildePath("/srv/app", null)).toBe("/srv/app");
    // A root home would turn every path into ~.
    expect(tildePath("/srv/app", "/")).toBe("/srv/app");
  });

  it("labels the trigger with the device name", () => {
    expect(
      deviceFolderLabel({
        deviceId: "mac",
        deviceName: "macbook",
        path: "/Users/ray/code/foo",
        home: "/Users/ray",
      }),
    ).toBe("macbook:~/code/foo");
  });

  it("joins a child without doubling the separator at a root", () => {
    expect(childPath("/", "Users")).toBe("/Users");
    expect(childPath("/Users", "ray")).toBe("/Users/ray");
    expect(childPath("C:\\", "Work")).toBe("C:\\Work");
    expect(childPath("C:\\Work", "rome")).toBe("C:\\Work\\rome");
  });
});
