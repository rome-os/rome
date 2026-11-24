import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createComputerUseHost, createComputerUseNativeBridge } from "../../dist/computer-use.js";
import type {
  ComputerUseHello,
  ComputerUseObservation,
  ComputerUseReceipt,
  ComputerUseWindow,
} from "../../dist/computer-use.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runID = process.argv[2] ?? `background-${Date.now()}`;
assert(/^[\w-]+$/.test(runID));
const directory = resolve(repo, ".scratch/desktop-controller/runs", runID);
await mkdir(directory, { recursive: true, mode: 0o700 });
const title = `Rome Background ${runID}.txt`,
  target = resolve(directory, title);
await writeFile(target, "", { flag: "wx", mode: 0o600 });
const execute = promisify(execFile);
const options = {
  bundledAppPath: resolve(
    repo,
    "packages/rome-node-core-darwin-arm64/dist/native/Rome Computer Use.app",
  ),
};
const a = createComputerUseHost(options),
  b = createComputerUseHost(options),
  bridge = createComputerUseNativeBridge(options);
const peerA = `background-a-${runID}`,
  peerB = `background-b-${runID}`;
const rows: unknown[] = [];
let pid: number | undefined,
  aID: string | undefined,
  bID: string | undefined,
  failure: string | undefined;
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) {
  const until = Date.now() + 8000;
  do {
    const value = await read().catch(() => undefined);
    if (value !== undefined && accepts(value)) return value;
    await delay(70);
  } while (Date.now() < until);
  throw Error(label);
}
async function call<T>(
  host: typeof a,
  peer: string,
  action: string,
  args: Record<string, unknown>,
): Promise<T> {
  const reply = await host.run(action, args, peer);
  rows.push({ action, reply });
  assert(reply.ok, JSON.stringify(reply));
  return reply.result as T;
}
const hello = () => bridge.call("hello", {}) as Promise<ComputerUseHello>;
try {
  assert.equal((await hello()).activeSessions, 0);
  await execute("/usr/bin/open", ["-a", "TextEdit", target]);
  await delay(400);
  await execute("/usr/bin/open", [
    "-a",
    resolve(repo, ".scratch/desktop-controller/Native Test.app"),
    "--args",
    directory,
  ]);
  const ready = await waitFor(
    () =>
      readFile(resolve(directory, "native-state.json"), "utf8").then(
        (value) => JSON.parse(value) as { pid: number; isActive: boolean },
      ),
    (s) => s.isActive,
    "Native foreground fixture did not start",
  );
  pid = ready.pid;
  // Verify empty computer.bind({}) stays rejected now that whole-desktop binding is disabled.
  const emptyBind = await a.run("computer.bind", {}, peerA);
  rows.push({ action: "computer.bind.empty", reply: emptyBind });
  assert.equal(emptyBind.ok, false);
  assert.equal(emptyBind.error?.code, "window_selection_required");
  const windowsA = await waitFor(
    () => call<{ windows: ComputerUseWindow[] }>(a, peerA, "computer.windows", {}),
    (value) => value.windows.some((w) => w.title === title),
    "Synthetic TextEdit window was not listed",
  );
  const candidateA = windowsA.windows.find((w) => w.title === title)!;
  const windowsB = await call<{ windows: ComputerUseWindow[] }>(b, peerB, "computer.windows", {});
  const candidateB = windowsB.windows.find((w) => w.title === title)!;
  assert(candidateB);
  aID = (
    await call<{ sessionId: string }>(a, peerA, "computer.bind", {
      windowRef: candidateA.windowRef,
    })
  ).sessionId;
  // The helper admits one live binding per exact window; a competing bind must fail with busy.
  const competingBind = await b.run("computer.bind", { windowRef: candidateB.windowRef }, peerB);
  rows.push({ action: "computer.bind.competing", reply: competingBind });
  assert.equal(competingBind.ok, false);
  assert.equal(competingBind.error?.code, "busy");
  const before = await hello();
  const image = await a.runBinary(
    "computer.observe",
    { sessionId: aID, screenshot: true },
    new Uint8Array(),
    peerA,
  );
  assert(image.response.ok, JSON.stringify(image.response));
  await writeFile(resolve(directory, "before.png"), image.body, { flag: "wx", mode: 0o600 });
  const observation = image.response.result as ComputerUseObservation;
  const field = observation.elements.find(
    (e) => e.role === "AXTextArea" && Array.isArray(e.actions) && e.actions.includes("setValue"),
  );
  assert(field);
  const value = "Background mode still works · 中文";
  const actionId = randomUUID();
  await call(a, peerA, "computer.act", {
    sessionId: aID,
    actionId,
    observationId: observation.observationId,
    stateVersion: observation.stateVersion,
    ref: field.ref,
    action: { type: "setValue", value },
  });
  const verification = await call<ComputerUseReceipt>(a, peerA, "computer.verify", {
    sessionId: aID,
    actionId,
  });
  assert.equal(verification.effectVerified, true);
  const final = await a.runBinary(
    "computer.observe",
    { sessionId: aID, screenshot: true },
    new Uint8Array(),
    peerA,
  );
  assert(final.response.ok);
  await writeFile(resolve(directory, "after.png"), final.body, { flag: "wx", mode: 0o600 });
  // Release A and confirm its stop before B refreshes the window reference for independent readback.
  const releasedAID = aID;
  await waitFor(
    () => call<{ stopConfirmed: boolean }>(a, peerA, "computer.end", { sessionId: releasedAID }),
    (receipt) => receipt.stopConfirmed,
    "Session A stop was not confirmed",
  );
  aID = undefined;
  const refreshedWindowsB = await call<{ windows: ComputerUseWindow[] }>(
    b,
    peerB,
    "computer.windows",
    {},
  );
  const refreshedCandidateB = refreshedWindowsB.windows.find((w) => w.title === title);
  assert(refreshedCandidateB);
  bID = (
    await call<{ sessionId: string }>(b, peerB, "computer.bind", {
      windowRef: refreshedCandidateB.windowRef,
    })
  ).sessionId;
  assert.notEqual(releasedAID, bID);
  const independent = await call<ComputerUseObservation>(b, peerB, "computer.observe", {
    sessionId: bID,
    screenshot: false,
  });
  assert(independent.elements.some((e) => e.role === "AXTextArea" && e.value === value));
  const after = await hello();
  rows.push({ before, after, independent, verification });
  const beforeFocus = before.focus as { frontPID: number; keyFocusPID: number; pointer: unknown },
    afterFocus = after.focus as typeof beforeFocus;
  assert.equal(beforeFocus.frontPID, pid);
  assert.equal(afterFocus.frontPID, pid);
  assert.equal(afterFocus.keyFocusPID, beforeFocus.keyFocusPID);
  assert.deepEqual(afterFocus.pointer, beforeFocus.pointer);
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
} finally {
  if (aID) await a.run("computer.cancel", { sessionId: aID }, peerA);
  if (bID) await b.run("computer.cancel", { sessionId: bID }, peerB);
  a.disconnect();
  b.disconnect();
  await a.idle();
  await b.idle();
  // Close only the synthetic TextEdit document without touching whole-desktop focus.
  try {
    await execute("/usr/bin/osascript", [
      "-e",
      'on run argv\nset targetPath to item 1 of argv\ntell application "TextEdit"\nrepeat with d in (every document)\ntry\nif (path of d as text) is targetPath then close d saving no\nend try\nend repeat\nend tell\nend run',
      target,
    ]);
    await delay(350);
    const cleanup = createComputerUseHost(options),
      peer = `cleanup-${runID}`;
    try {
      const finalWindows = await cleanup.run("computer.windows", {}, peer);
      rows.push({ action: "cleanup.close", finalWindows });
      if (finalWindows.ok)
        assert(
          !(finalWindows.result as { windows: ComputerUseWindow[] }).windows.some(
            (w) => w.title === title,
          ),
          "Synthetic document remained open",
        );
    } finally {
      cleanup.disconnect();
      await cleanup.idle();
    }
  } catch (error) {
    failure ??= String(error);
  }
  if (pid)
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  await delay(250);
  let exited = true;
  if (pid)
    try {
      process.kill(pid, 0);
      exited = false;
    } catch {}
  if (!exited) failure ??= "Foreground fixture did not exit";
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify(
      {
        runID,
        status: failure ? "failed" : "passed",
        failure,
        rows,
        cleanup: { pid, exited, syntheticDocumentCloseRequested: true },
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
}
console.log(JSON.stringify({ directory, status: failure ? "failed" : "passed", failure }));
if (failure) process.exitCode = 1;
