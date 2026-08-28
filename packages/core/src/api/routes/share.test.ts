import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createWebchatRuntime } from "./webchat.js";
import { shareRoutes } from "./share.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import type { ChatShareSnapshot } from "../share-snapshot.js";

interface PublicSharePayload {
  id: string;
  title: string;
  snapshot: ChatShareSnapshot;
  layout: unknown[];
}

describe("Share chat", () => {
  const originalProjectsRoot = process.env.ROME_PROJECTS_ROOT;
  let testDb: TestDb;
  let deps: TestDeps;
  let projectsRoot: string;

  beforeEach(async () => {
    projectsRoot = mkdtempSync(join(tmpdir(), "rome-share-route-"));
    process.env.ROME_PROJECTS_ROOT = projectsRoot;
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
  });

  afterEach(() => {
    testDb.close();
    rmSync(projectsRoot, { recursive: true, force: true });
    if (originalProjectsRoot === undefined) delete process.env.ROME_PROJECTS_ROOT;
    else process.env.ROME_PROJECTS_ROOT = originalProjectsRoot;
  });

  async function seedTwoTurnSession(projectName = "default"): Promise<string> {
    const sessionId = "sess-share";
    await deps.webchatRepo.createSession(sessionId, "My chat", undefined, projectName);
    await deps.webchatRepo.addMessage(
      "m1u",
      sessionId,
      "user",
      JSON.stringify([{ type: "text", content: "first question" }]),
      "turn-1",
    );
    await deps.webchatRepo.addMessage(
      "m1a",
      sessionId,
      "assistant",
      JSON.stringify([{ type: "text", content: "first answer" }]),
      "turn-1",
    );
    await deps.webchatRepo.addMessage(
      "m2u",
      sessionId,
      "user",
      JSON.stringify([{ type: "text", content: "second question" }]),
      "turn-2",
    );
    await deps.webchatRepo.addMessage(
      "m2a",
      sessionId,
      "assistant",
      JSON.stringify([{ type: "text", content: "second answer" }]),
      "turn-2",
    );
    return sessionId;
  }

  it("freezes only the selected turns and serves them on the public route", async () => {
    const sessionId = await seedTwoTurnSession();
    const manage = createWebchatRuntime(deps).routes;

    const createRes = await manage.request(`/chat/sessions/${sessionId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnIds: ["turn-1"] }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; url: string };
    expect(created.url).toBe(`/share/${created.id}`);

    const publicApp = shareRoutes(deps);
    const readRes = await publicApp.request(`/share/${created.id}`);
    expect(readRes.status).toBe(200);
    const payload = (await readRes.json()) as PublicSharePayload;
    expect(payload.title).toBe("My chat");
    expect(payload.snapshot.mainSessionId).toBe(sessionId);
    const turnIds = new Set(payload.snapshot.messages.map((m) => m.turnId));
    expect(turnIds).toEqual(new Set(["turn-1"]));
    expect(payload.snapshot.messages).toHaveLength(2);
  });

  it("recurses into handoff child sessions", async () => {
    const sessionId = "sess-handoff";
    const childId = "sess-child";
    await deps.webchatRepo.createSession(sessionId, "Parent");
    await deps.webchatRepo.createSession(
      childId,
      "Child",
      undefined,
      undefined,
      null,
      undefined,
      undefined,
      "webchat_handoff",
    );
    await deps.webchatRepo.addMessage(
      "p-u",
      sessionId,
      "user",
      JSON.stringify([{ type: "text", content: "kick off" }]),
      "turn-1",
    );
    await deps.webchatRepo.addMessage(
      "p-a",
      sessionId,
      "assistant",
      JSON.stringify([
        { type: "handoff", toolUseId: "h1", appId: "studio", childSessionId: childId },
      ]),
      "turn-1",
    );
    await deps.webchatRepo.addMessage(
      "c-a",
      childId,
      "assistant",
      JSON.stringify([{ type: "text", content: "child reply" }]),
      "child-turn-1",
    );

    const manage = createWebchatRuntime(deps).routes;
    const createRes = await manage.request(`/chat/sessions/${sessionId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnIds: ["turn-1"] }),
    });
    const created = (await createRes.json()) as { id: string };

    const payload = (await (
      await shareRoutes(deps).request(`/share/${created.id}`)
    ).json()) as PublicSharePayload;
    const sessions = new Set(payload.snapshot.messages.map((m) => m.sessionId));
    expect(sessions).toEqual(new Set([sessionId, childId]));
  });

  it("strips browser (desktop) widgets from the frozen layout", async () => {
    const sessionId = await seedTwoTurnSession();
    await deps.webchatRepo.saveLayout(sessionId, [
      { id: "w1", type: "app", targetId: "studio", order: 1 },
      { id: "w2", type: "desktop", order: 2 },
      { id: "w3", type: "projects", order: 3 },
    ]);
    const manage = createWebchatRuntime(deps).routes;
    const created = (await (
      await manage.request(`/chat/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnIds: ["turn-1"] }),
      })
    ).json()) as { id: string };

    const payload = (await (
      await shareRoutes(deps).request(`/share/${created.id}`)
    ).json()) as PublicSharePayload;
    const types = (payload.layout as Array<{ type: string }>).map((w) => w.type);
    expect(types).toEqual(["app", "projects"]);
  });

  it("lists and revokes shares; revoked links 404", async () => {
    const sessionId = await seedTwoTurnSession();
    const manage = createWebchatRuntime(deps).routes;
    const created = (await (
      await manage.request(`/chat/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnIds: ["turn-1", "turn-2"] }),
      })
    ).json()) as { id: string };

    const list = (await (
      await manage.request(`/chat/sessions/${sessionId}/shares`)
    ).json()) as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toContain(created.id);

    const delRes = await manage.request(`/chat/shares/${created.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const afterRevoke = await shareRoutes(deps).request(`/share/${created.id}`);
    expect(afterRevoke.status).toBe(404);

    const emptyList = (await (
      await manage.request(`/chat/sessions/${sessionId}/shares`)
    ).json()) as unknown[];
    expect(emptyList).toHaveLength(0);
  });

  it("scopes the public projects browser to the share's project only", async () => {
    // Two projects on disk; the share is for proj-a, so proj-b must be unreachable.
    mkdirSync(join(projectsRoot, "proj-a"), { recursive: true });
    writeFileSync(join(projectsRoot, "proj-a", "inside.txt"), "in scope");
    mkdirSync(join(projectsRoot, "proj-b"), { recursive: true });
    writeFileSync(join(projectsRoot, "proj-b", "secret.txt"), "out of scope");

    const sessionId = await seedTwoTurnSession("proj-a");
    await deps.webchatRepo.saveLayout(sessionId, [{ id: "w1", type: "projects", order: 1 }]);

    const manage = createWebchatRuntime(deps).routes;
    const created = (await (
      await manage.request(`/chat/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnIds: ["turn-1"] }),
      })
    ).json()) as { id: string };

    const publicApp = shareRoutes(deps);
    const treeRes = await publicApp.request(`/share/${created.id}/projects/tree`);
    expect(treeRes.status).toBe(200);
    const tree = (await treeRes.json()) as Array<{ name: string }>;
    const names = tree.map((c) => c.name);
    // Rooted at proj-a: its file shows, proj-b's sibling file is not addressable.
    expect(names).toContain("inside.txt");
    expect(names).not.toContain("secret.txt");

    // proj-b's file cannot be read through this share's logical space.
    const fileRes = await publicApp.request(
      `/share/${created.id}/projects/file?path=${encodeURIComponent("projects/secret.txt")}`,
    );
    expect(fileRes.status).toBe(404);
  });

  it("404s the projects browser for a chat-only share (no projects tile)", async () => {
    const sessionId = await seedTwoTurnSession();
    // No projects widget in the layout → the projects API stays closed.
    await deps.webchatRepo.saveLayout(sessionId, [
      { id: "w1", type: "app", targetId: "studio", order: 1 },
    ]);

    const manage = createWebchatRuntime(deps).routes;
    const created = (await (
      await manage.request(`/chat/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnIds: ["turn-1"] }),
      })
    ).json()) as { id: string };

    const treeRes = await shareRoutes(deps).request(`/share/${created.id}/projects/tree`);
    expect(treeRes.status).toBe(404);
  });

  it("rewrites the frozen projects selection to be project-relative", async () => {
    const sessionId = await seedTwoTurnSession("proj-a");
    await deps.webchatRepo.saveLayout(sessionId, [
      { id: "w1", type: "projects", order: 1, selectedPath: "projects/proj-a/src/index.ts" },
    ]);

    const manage = createWebchatRuntime(deps).routes;
    const created = (await (
      await manage.request(`/chat/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnIds: ["turn-1"] }),
      })
    ).json()) as { id: string };

    const payload = (await (
      await shareRoutes(deps).request(`/share/${created.id}`)
    ).json()) as PublicSharePayload;
    const projects = (payload.layout as Array<{ type: string; selectedPath?: string }>).find(
      (w) => w.type === "projects",
    );
    expect(projects?.selectedPath).toBe("projects/src/index.ts");
  });

  it("deletes a chat's shares when the source chat is deleted (no ghost links)", async () => {
    const sessionId = await seedTwoTurnSession();
    const manage = createWebchatRuntime(deps).routes;
    const created = (await (
      await manage.request(`/chat/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnIds: ["turn-1"] }),
      })
    ).json()) as { id: string };

    // Live before deletion.
    expect((await shareRoutes(deps).request(`/share/${created.id}`)).status).toBe(200);

    await deps.webchatRepo.deleteSession(sessionId);

    // The public link is gone, not stranded as an unrevokable ghost.
    expect((await shareRoutes(deps).request(`/share/${created.id}`)).status).toBe(404);
    expect(await deps.webchatRepo.getSharedChat(created.id)).toBeNull();
  });

  it("rejects an empty turn selection and 404s unknown tokens", async () => {
    const sessionId = await seedTwoTurnSession();
    const manage = createWebchatRuntime(deps).routes;
    const badRes = await manage.request(`/chat/sessions/${sessionId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnIds: [] }),
    });
    expect(badRes.status).toBe(400);

    const missing = await shareRoutes(deps).request("/share/does-not-exist");
    expect(missing.status).toBe(404);
  });
});
