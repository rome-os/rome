/**
 * Core's createTreeHandler answers 404 for a missing explicit folder path.
 * The watch reconciler relies on exactly that: after an `unlinkDir` event it
 * re-verifies deletion with `GET /tree?path=...`, and only a 404 clears the
 * stale selection. A 200 [] (the mock's old behavior) leaves a deleted
 * directory selected forever. These tests pin the event + 404 contract.
 */
// @rstest-environment jsdom
import { afterAll, beforeAll, expect, test } from "@rstest/core";
import { setupServer } from "msw/node";
import { dir, file, fileBrowserHandlers } from "./file-browser";

// MSW resolves relative request handlers against the jsdom document origin,
// which rstest serves on port 3000; the path under test is what matters.
const BASE = "http://localhost:3000";
const API = `${BASE}/api/files`;

// Fixture top-level nodes carry the logicalRoot prefix directly (as the real
// projects/memory fixtures do); there is no node named after the root itself.
const fixture = [
  dir("projects/notes", [file("projects/notes/a.md", "hi")]),
  dir("projects/watch-scope", [file("projects/watch-scope/nested.md", "first")]),
  file("projects/readme.txt", "x"),
];

const server = setupServer(
  ...fileBrowserHandlers({ apiBasePath: "/api/files", logicalRoot: "projects", tree: fixture }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

test("tree for the root and an existing directory lists children", async () => {
  const root = await (await fetch(`${API}/tree?depth=1`)).json();
  expect(root.map((n: { path: string }) => n.path)).toEqual([
    "projects/notes",
    "projects/watch-scope",
    "projects/readme.txt",
  ]);

  const notes = await (await fetch(`${API}/tree?path=projects/notes&depth=1`)).json();
  expect(notes.map((n: { name: string }) => n.name)).toEqual(["a.md"]);
});

test("tree returns 404 for a missing explicit path and 400 for a file path", async () => {
  const missing = await fetch(`${API}/tree?path=projects/gone&depth=1`);
  expect(missing.status).toBe(404);

  const filePath = await fetch(`${API}/tree?path=projects/readme.txt&depth=1`);
  expect(filePath.status).toBe(400);
});

test("events reach only streams watching the changed directory", async () => {
  const rootReader = (await fetch(`${API}/events`)).body!.getReader();
  const nestedReader = (
    await fetch(`${API}/events?watch=${encodeURIComponent("projects/watch-scope")}`)
  ).body!.getReader();
  const decoder = new TextDecoder();
  await rootReader.read();
  await nestedReader.read();

  const nestedWrite = await fetch(`${API}/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "projects/watch-scope/nested.md", content: "second" }),
  });
  expect(nestedWrite.ok).toBe(true);
  expect(decoder.decode((await nestedReader.read()).value)).toContain(
    '"path":"projects/watch-scope/nested.md"',
  );

  const rootWrite = await fetch(`${API}/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "projects/readme.txt", content: "updated" }),
  });
  expect(rootWrite.ok).toBe(true);
  expect(decoder.decode((await rootReader.read()).value)).toContain('"path":"projects/readme.txt"');

  rootReader.cancel().catch(() => {});
  nestedReader.cancel().catch(() => {});
});

test("deleting a directory emits unlinkDir and its tree path then resolves 404", async () => {
  const events = await fetch(`${API}/events`);
  expect(events.body).not.toBeNull();
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();

  // First frame is the ready rebaseline.
  const ready = await reader.read();
  expect(decoder.decode(ready.value)).toContain("event: ready");

  const deleteResponse = await fetch(`${API}/file?path=${encodeURIComponent("projects/notes")}`, {
    method: "DELETE",
  });
  expect(deleteResponse.ok).toBe(true);

  // The watch stream pushes the unlinkDir frame for the deleted directory.
  const change = await reader.read();
  const frame = decoder.decode(change.value);
  expect(frame).toContain("event: change");
  expect(frame).toContain('"kind":"unlinkDir"');
  expect(frame).toContain('"path":"projects/notes"');

  // Reconciler re-verification: the explicit folder path is now 404, which is
  // what lets the frontend clear the stale selection.
  const afterDelete = await fetch(`${API}/tree?path=projects/notes&depth=1`);
  expect(afterDelete.status).toBe(404);

  reader.cancel().catch(() => {});
});
