import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@rstest/core";

const execFileAsync = promisify(execFile);

describe("test-env.sh", () => {
  it("drops ambient runtime configuration and forces the test environment", async () => {
    const script = fileURLToPath(new URL("./test-env.sh", import.meta.url));
    const { stdout } = await execFileAsync(
      script,
      [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          PANTHEON_DOMAIN: "production.example",
          GH_TOKEN: "secret",
          TEST_DATABASE_URL: "postgres://production.example/rome",
          FORCE_COLOR: "1",
          CI: "unexpected-parent-value",
          GITHUB_ACTIONS: "unexpected-parent-value",
        },
      },
    );

    const childEnv = JSON.parse(stdout) as NodeJS.ProcessEnv;
    expect(childEnv.NODE_ENV).toBe("test");
    expect(childEnv.TZ).toBe("UTC");
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.HOME).toBe(process.env.HOME);
    expect(childEnv.TERM).toBe("dumb");
    expect(childEnv.NO_COLOR).toBe("1");
    expect(childEnv.FORCE_COLOR).toBeUndefined();
    expect(childEnv.CI).toBe("true");
    expect(childEnv.GITHUB_ACTIONS).toBe("true");
    expect(childEnv.PANTHEON_DOMAIN).toBeUndefined();
    expect(childEnv.GH_TOKEN).toBeUndefined();
    expect(childEnv.TEST_DATABASE_URL).toBeUndefined();
  });
});
