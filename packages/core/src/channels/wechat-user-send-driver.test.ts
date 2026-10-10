import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "@rstest/core";

// The driver runs against a live desktop client in production. Its fixtures
// script a fake accessibility tree, desktop, store and clock instead.
it("drives a fake accessibility tree through every send outcome", () => {
  execFileSync(
    "python3",
    [fileURLToPath(new URL("./wechat-user-send-driver-fixtures.py", import.meta.url))],
    { stdio: "pipe" },
  );
});
