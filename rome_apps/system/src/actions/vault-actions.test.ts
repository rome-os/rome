import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSigner } from "../../../../packages/signer/src/signer.js";
import { createAction as createApply } from "./vault-apply/index.js";
import { createAction as createSearch } from "./vault-search/index.js";

const apply = createApply({ name: "vault_apply", type: "system" } as ActionConfig);
const search = createSearch({ name: "vault_search", type: "system" } as ActionConfig);

const cleanups: Array<() => void> = [];
afterEach(() => {
  rs.unstubAllEnvs();
  while (cleanups.length) cleanups.pop()?.();
});

const PIN = "123456";

function signerCall(socketPath: string, method: string, path: string, body: unknown) {
  return new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** Starts a signer with a PIN and GITHUB_TOKEN. Returns a function that grants a secret. */
async function startVault(extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "vault-actions-"));
  const socketPath = join(dir, "signer.sock");
  const { server } = await startSigner({
    audience: "https://cloud.example",
    keyDir: join(dir, "keys"),
    socketPath,
    log: () => {},
  });
  cleanups.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  rs.stubEnv("ROME_SIGNER_SOCKET", socketPath);
  await signerCall(socketPath, "POST", "/v1/pin", { pin: PIN });
  await signerCall(socketPath, "PUT", "/v1/secrets/GITHUB_TOKEN", {
    value: "ghp_topsecret",
    description: "CI token",
    pin: PIN,
  });
  for (const name of extra) {
    await signerCall(socketPath, "PUT", `/v1/secrets/${name}`, { value: "other-secret", pin: PIN });
  }
  return (names: string | string[], ttlSeconds: number) =>
    signerCall(socketPath, "POST", "/v1/grants", {
      names: [names].flat(),
      ttlSeconds,
      pin: PIN,
    });
}

describe("vault_apply", () => {
  it("is described for agents and requires input", () => {
    expect(apply.config.name).toBe("vault_apply");
    // The names are optional in the schema: exactly one of `names` and `name` is checked on input.
    expect(apply.inputSchema.required).toEqual(["reason"]);
    // The description lives in action.yaml, which folds it onto one line per paragraph.
    const yaml = readFileSync(
      new URL("./vault-apply/action.yaml", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(yaml).toContain("vault load A,B -- <command>");
    expect(yaml).toContain("Never ask for the PIN in the chat");
  });

  it("previews a secret-access card, with title and summary for surfaces that draw only the generic one", () => {
    expect(apply.preview?.({ name: "GITHUB_TOKEN", reason: "Push the release tag" })).toEqual({
      kind: "secret_access",
      name: "GITHUB_TOKEN",
      names: ["GITHUB_TOKEN"],
      ttlMinutes: 15,
      reason: "Push the release tag",
      title: "Use GITHUB_TOKEN for 15 min",
      summary: "Push the release tag",
    });
    expect(apply.preview?.({ name: "GITHUB_TOKEN", ttlMinutes: 60, reason: "r" })).toMatchObject({
      kind: "secret_access",
      ttlMinutes: 60,
      title: "Use GITHUB_TOKEN for 60 min",
    });
  });

  it("previews several names in one card, with the first as `name` for older readers", () => {
    expect(
      apply.preview?.({ names: ["GITHUB_TOKEN", "STRIPE_KEY"], ttlMinutes: 30, reason: "r" }),
    ).toEqual({
      kind: "secret_access",
      name: "GITHUB_TOKEN",
      names: ["GITHUB_TOKEN", "STRIPE_KEY"],
      ttlMinutes: 30,
      reason: "r",
      title: "Use GITHUB_TOKEN, STRIPE_KEY for 30 min",
      summary: "r",
    });
  });

  it("reports the grant the signer holds and points at the CLI", async () => {
    const grant = await startVault();
    await grant("GITHUB_TOKEN", 900);
    const before = Date.now();
    const result = await apply.execute({ name: "GITHUB_TOKEN", reason: "Push the tag" });
    expect(result.status).toBe("ok");
    const data = (result as { data: { name: string; expiresAt: string; message: string } }).data;
    expect(data.name).toBe("GITHUB_TOKEN");
    expect(data).toMatchObject({ names: ["GITHUB_TOKEN"] });
    expect(Date.parse(data.expiresAt) - before).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(data.expiresAt) - before).toBeLessThanOrEqual(15 * 60_000 + 5000);
    expect(data.message).toContain("vault load GITHUB_TOKEN -- <command>");
    expect(data.message).toContain(data.expiresAt);
    expect(JSON.stringify(data)).not.toContain("topsecret");
  });

  it("reports several grants with the earliest expiry and one load line", async () => {
    const grant = await startVault(["STRIPE_KEY", "AWS_KEY"]);
    await grant(["GITHUB_TOKEN", "STRIPE_KEY"], 300);
    await grant("AWS_KEY", 3600);
    const names = ["GITHUB_TOKEN", "STRIPE_KEY", "AWS_KEY"];
    const result = await apply.execute({ names, reason: "Release" });
    expect(result.status).toBe("ok");
    const { data } = result as {
      data: { names: string[]; expiresAt: string; message: string };
    };
    expect(data.names).toEqual(names);
    // The request ends with its earliest grant, the five-minute one.
    expect(Date.parse(data.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000 + 5000);
    expect(data.message).toBe(
      `Approved. Run \`vault load GITHUB_TOKEN,STRIPE_KEY,AWS_KEY -- <command>\` before ${data.expiresAt}. ` +
        "The command gets GITHUB_TOKEN, STRIPE_KEY and AWS_KEY in its environment, and its output is masked.",
    );
  });

  it("names the secrets that have no grant yet, and the ones that do not exist", async () => {
    const grant = await startVault(["STRIPE_KEY"]);
    await grant("GITHUB_TOKEN", 300);
    const pending = await apply.execute({ names: ["GITHUB_TOKEN", "STRIPE_KEY"], reason: "r" });
    expect(pending).toEqual({
      status: "error",
      error:
        "There is no grant for STRIPE_KEY. The guardian approves vault_apply with the PIN in the dashboard.",
    });
    const missing = await apply.execute({ names: ["GITHUB_TOKEN", "MISSING_KEY"], reason: "r" });
    expect((missing as { error: string }).error).toContain("no secret named MISSING_KEY");
  });

  it("creates no grant of its own", async () => {
    await startVault();
    const result = await apply.execute({ name: "GITHUB_TOKEN", reason: "Push the tag" });
    expect(result).toEqual({
      status: "error",
      error:
        "There is no grant for GITHUB_TOKEN. The guardian approves vault_apply with the PIN in the dashboard.",
    });
    expect(await apply.execute({ name: "GITHUB_TOKEN", reason: "Push the tag" })).toMatchObject({
      status: "error",
    });
  });

  it.each([
    { name: "GITHUB_TOKEN", reason: "r", ttlMinutes: 0 },
    { name: "GITHUB_TOKEN", reason: "r", ttlMinutes: 181 },
    { name: "GITHUB_TOKEN", reason: "r", ttlMinutes: 1.5 },
    { name: "GITHUB_TOKEN", reason: " " },
    { name: "github_token", reason: "r" },
    { name: "GITHUB_TOKEN", reason: "r", extra: true },
    { reason: "r" },
    { name: "GITHUB_TOKEN", names: ["GITHUB_TOKEN"], reason: "r" },
    { names: [], reason: "r" },
    { names: ["GITHUB_TOKEN", "GITHUB_TOKEN"], reason: "r" },
    { names: Array.from({ length: 11 }, (_, i) => `KEY_${i}`), reason: "r" },
    { names: ["lower"], reason: "r" },
  ])("rejects invalid input %j", async (input) => {
    await startVault();
    expect((await apply.execute(input)).status).toBe("error");
  });

  it("reports an unknown secret", async () => {
    await startVault();
    const result = await apply.execute({ name: "MISSING_KEY", reason: "r" });
    expect(result).toMatchObject({ status: "error" });
    expect((result as { error: string }).error).toContain("MISSING_KEY");
  });

  it("explains when there is no signer", async () => {
    rs.stubEnv("ROME_SIGNER_SOCKET", "");
    expect(await apply.execute({ name: "GITHUB_TOKEN", reason: "r" })).toEqual({
      status: "error",
      error: "The vault needs the signer, which is not running on this instance.",
    });
  });
});

describe("vault_search", () => {
  it("lists metadata without values, and shows a live grant", async () => {
    const grant = await startVault();
    await grant("GITHUB_TOKEN", 300);
    const result = await search.execute({});
    expect(result.status).toBe("ok");
    const { secrets } = (result as { data: { secrets: Array<Record<string, unknown>> } }).data;
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      name: "GITHUB_TOKEN",
      description: "CI token",
      lastUsedAt: null,
    });
    expect(typeof secrets[0].grantedUntil).toBe("string");
    expect(JSON.stringify(result)).not.toContain("topsecret");
  });

  it("filters by query and is read-only without approval", async () => {
    await startVault();
    const miss = await search.execute({ query: "stripe" });
    expect((miss as { data: { secrets: unknown[] } }).data.secrets).toEqual([]);
    const hit = await search.execute({ query: "ci tok" });
    expect((hit as { data: { secrets: unknown[] } }).data.secrets).toHaveLength(1);
    expect(search.preview).toBeUndefined();
  });
});
