// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import type { ChatSession } from "@/lib/chat-types";
import { emitSessionsChanged } from "@/lib/session-events";
import ProjectDetailPage from "./ProjectDetailPage";
import ProjectsIndexPage from "./ProjectsIndexPage";

function chat(id: string, name: string, projectPath: string, activityAt: string): ChatSession {
  return {
    id,
    name,
    personaId: null,
    projectName: projectPath,
    projectPath,
    createdAt: activityAt,
    activityAt,
    lastSeenActivityAt: activityAt,
    unread: false,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// Core names a record after the last segment of its folder.
const record = (path: string, displayName = path.split("/").pop() ?? path) => ({
  name: path,
  displayName,
  projectPath: path,
  path: `/root/projects/${path}`,
});
// Records beyond the two every test has.
let extraRecords: ReturnType<typeof record>[] = [];

let sessions: ChatSession[] = [];
let sessionsFail = false;
// Tree paths whose read fails, as a transient server error would.
const failingTrees = new Set<string>();
let resolveFails = false;
// While set, resolving a path under the projects root waits on it.
let resolveGate: Promise<void> | null = null;
// What sits under the projects root, beside the folders core has records for.
const rootEntries: Record<string, "directory" | "file"> = {
  "projects/alpha": "directory",
  "projects/empty": "directory",
  // A folder with neither a record nor chats.
  "projects/loose": "directory",
  "projects/todo.md": "file",
};
const createdProjects: string[] = [];
// While set, creating a project waits on it.
let createGate: Promise<void> | null = null;
const fetchMock = rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost");
  if (url.pathname === "/api/chat/sessions") {
    return sessionsFail ? new Response("down", { status: 500 }) : json(sessions);
  }
  if (url.pathname === "/api/chat/projects") {
    if (init?.method === "POST") {
      const { name } = JSON.parse(String(init.body)) as { name: string };
      createdProjects.push(name);
      if (createGate) await createGate;
      return json(record(name));
    }
    // Core's records: the folders made outside them, such as `src`, are not projects.
    return json({
      rootPath: "/root/projects",
      defaultPath: "/root/projects/default",
      projects: [record("alpha"), record("empty"), ...extraRecords],
    });
  }
  if (url.pathname === "/api/projects/resolve") {
    if (resolveGate) await resolveGate;
    if (resolveFails) return new Response("down", { status: 500 });
    const path = url.searchParams.get("path") ?? "";
    // Core rejects a path that would leave the projects root.
    if (path.split("/").includes("..")) return new Response("bad path", { status: 400 });
    if (path === "projects/locked") return new Response("sign in", { status: 401 });
    return json({ type: rootEntries[path] ?? "missing", path });
  }
  if (url.pathname === "/api/projects/tree") {
    const path = url.searchParams.get("path") ?? "";
    if (failingTrees.has(path)) return new Response("down", { status: 500 });
    if (path === "projects") {
      return json(
        Object.entries(rootEntries).map(([entry, type]) => ({
          name: entry.slice("projects/".length),
          path: entry,
          type,
        })),
      );
    }
    if (path === "projects/crowded") {
      // In the filesystem's order, not by name, and more than the panel shows.
      return json(
        Array.from({ length: 12 }, (_, i) => {
          const name = `note-${String(12 - i).padStart(2, "0")}.md`;
          return { name, path: `projects/crowded/${name}`, type: "file" };
        }).concat([{ name: "zeta", path: "projects/crowded/zeta", type: "directory" }]),
      );
    }
    if (path === "projects/alpha") {
      return json([
        { name: "brief.md", path: "projects/alpha/brief.md", type: "file" },
        { name: "src", path: "projects/alpha/src", type: "directory" },
      ]);
    }
    return json([]);
  }
  return new Response("not found", { status: 404 });
});

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}

// The dialog selects its field a frame after it opens, so typing before then
// would lose the first characters to that selection.
async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

function renderAt(
  path: string,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects" element={<ProjectsIndexPage />} />
          <Route path="/projects/:projectPath" element={<ProjectDetailPage />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  rs.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  sessionsFail = false;
  extraRecords = [];
  failingTrees.clear();
  resolveFails = false;
  resolveGate = null;
  createdProjects.length = 0;
  createGate = null;
  sessions = [
    chat("a1", "Alpha older", "alpha", "2026-07-01T00:00:00.000Z"),
    chat("a2", "Alpha newest", "alpha", "2026-07-09T00:00:00.000Z"),
    // A chat whose project has no record still makes a project.
    chat("b1", "Beta only chat", "beta", "2026-07-05T00:00:00.000Z"),
  ];
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("Projects list", () => {
  it("shows every project record and chat project, most recently active first", async () => {
    renderAt("/projects");

    const links = await screen.findAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/alpha",
      "/projects/beta",
      "/projects/empty",
    ]);
    const alpha = links[0];
    expect(within(alpha).getByText("Alpha newest")).toBeTruthy();
    expect(within(alpha).getByText(/2 chats/)).toBeTruthy();
    expect(within(links[2]).getByText("No chats yet")).toBeTruthy();
    // A file at the root is not a project.
    expect(screen.queryByText("todo.md")).toBeNull();
  });

  it("creates a project through core's project records, which the composer's picker reads", async () => {
    const user = userEvent.setup();
    renderAt("/projects");

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Project name"), "launch-plan");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await screen.findByText(/"pathname":"\/projects\/launch-plan"/);
    expect(createdProjects).toEqual(["launch-plan"]);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => new URL(String(input), "http://localhost").pathname === "/api/projects/file",
      ),
    ).toBe(false);
  });

  it("creates the project once when Create is pressed again while it is being created", async () => {
    let openGate = () => {};
    createGate = new Promise((resolve) => {
      openGate = resolve;
    });
    const user = userEvent.setup();
    renderAt("/projects");

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Project name"), "launch-plan");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));
    openGate();

    await screen.findByText(/"pathname":"\/projects\/launch-plan"/);
    expect(createdProjects).toEqual(["launch-plan"]);
  });

  it("shows Create as busy while the project is being created", async () => {
    let openGate = () => {};
    createGate = new Promise((resolve) => {
      openGate = resolve;
    });
    const user = userEvent.setup();
    renderAt("/projects");

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Project name"), "launch-plan");
    const confirm = screen.getByRole("button", { name: "Create project" });
    await user.click(confirm);

    await rs.waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    openGate();
    await screen.findByText(/"pathname":"\/projects\/launch-plan"/);
  });

  it("does not ask core for its project records again when the chats change", async () => {
    renderAt("/projects");
    await screen.findAllByRole("link");
    const calls = (pathname: string) =>
      fetchMock.mock.calls.filter(
        ([input]) => new URL(String(input), "http://localhost").pathname === pathname,
      ).length;
    const sessionReads = calls("/api/chat/sessions");
    const recordReads = calls("/api/chat/projects");

    emitSessionsChanged();

    await rs.waitFor(() => expect(calls("/api/chat/sessions")).toBeGreaterThan(sessionReads));
    expect(calls("/api/chat/projects")).toBe(recordReads);
  });

  it("shows a chat renamed elsewhere when the guardian comes back", async () => {
    // The dashboard's own cache defaults: data stays fresh for ten seconds.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 10_000, retry: false } },
    });
    const first = renderAt("/projects/alpha", queryClient);
    expect(await screen.findByText("Alpha newest")).toBeTruthy();
    first.unmount();

    // Renamed in the chat, while no Projects page listened.
    sessions = sessions.map((s) => (s.id === "a2" ? { ...s, name: "Alpha renamed" } : s));
    renderAt("/projects/alpha", queryClient);

    expect(await screen.findByText("Alpha renamed")).toBeTruthy();
  });

  it("offers a retry when the lookup fails for any reason but a bad path", async () => {
    renderAt("/projects/locked");

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/There's no project/)).toBeNull();
  });

  it("narrows the cards to the projects whose name matches the search", async () => {
    const user = userEvent.setup();
    renderAt("/projects");

    await screen.findByText("alpha");
    await user.type(screen.getByLabelText("Search projects"), "bet");

    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("names a chat-only project in a subfolder by its whole path", async () => {
    sessions = [
      chat("s1", "Assets one", "alpha/assets", "2026-07-03T00:00:00.000Z"),
      chat("s2", "Assets two", "beta/assets", "2026-07-02T00:00:00.000Z"),
    ];
    renderAt("/projects");

    expect(await screen.findByText("alpha/assets")).toBeTruthy();
    expect(screen.getByText("beta/assets")).toBeTruthy();
  });

  it("names a recorded subfolder project by its whole path unless the guardian renamed it", async () => {
    extraRecords = [
      record("website-redesign/assets"),
      record("alpha/assets"),
      record("beta/assets"),
      record("beta/brand", "Brand kit"),
    ];
    sessions = [chat("s1", "Logo pass", "website-redesign/assets", "2026-07-03T00:00:00.000Z")];
    const user = userEvent.setup();
    renderAt("/projects");

    expect(await screen.findByText("website-redesign/assets")).toBeTruthy();
    expect(screen.getByText("alpha/assets")).toBeTruthy();
    expect(screen.getByText("beta/assets")).toBeTruthy();
    expect(screen.getByText("Brand kit")).toBeTruthy();
    expect(screen.queryByText("assets")).toBeNull();

    // Search matches the name the card shows.
    await user.type(screen.getByLabelText("Search projects"), "redesign/");
    expect(screen.getByText("website-redesign/assets")).toBeTruthy();
    expect(screen.queryByText("alpha/assets")).toBeNull();
  });

  it("titles a recorded subfolder project's page with its whole path", async () => {
    extraRecords = [record("website-redesign/assets")];
    renderAt(`/projects/${encodeURIComponent("website-redesign/assets")}`);

    expect(await screen.findByRole("heading", { name: "website-redesign/assets" })).toBeTruthy();
  });

  it("says when a project was updated in the dashboard's language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      renderAt("/projects");

      const alpha = (await screen.findAllByRole("link"))[0];
      const updated = new Date("2026-07-09T00:00:00.000Z").toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      });
      expect(within(alpha).getByText(new RegExp(`${updated}更新`))).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("clears an earlier name error once a valid name is sent", async () => {
    let openGate = () => {};
    createGate = new Promise((resolve) => {
      openGate = resolve;
    });
    const user = userEvent.setup();
    renderAt("/projects");

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Project name"), ".hidden");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const invalid = "Use a name without slashes that doesn't start with a dot.";
    expect(screen.getByText(invalid)).toBeTruthy();

    await user.clear(screen.getByLabelText("Project name"));
    await user.type(screen.getByLabelText("Project name"), "launch-plan");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(screen.queryByText(invalid)).toBeNull();
    openGate();
    await screen.findByText(/"pathname":"\/projects\/launch-plan"/);
  });

  it("stays on the list when the dialog is cancelled while the project is created", async () => {
    let openGate = () => {};
    createGate = new Promise((resolve) => {
      openGate = resolve;
    });
    const user = userEvent.setup();
    renderAt("/projects");

    await openCreateDialog(user);
    await user.type(screen.getByLabelText("Project name"), "launch-plan");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const listLoads = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          new URL(String(input), "http://localhost").pathname === "/api/chat/projects" &&
          init?.method !== "POST",
      ).length;
    const before = listLoads();
    openGate();

    // The list reloads with the new project, and the page stays put.
    await rs.waitFor(() => expect(listLoads()).toBeGreaterThan(before));
    expect(JSON.parse(screen.getByTestId("location").textContent ?? "{}").pathname).toBe(
      "/projects",
    );
    expect(createdProjects).toEqual(["launch-plan"]);
  });
});

describe("Project page", () => {
  it("lists the project's chats newest first beside its files", async () => {
    renderAt("/projects/alpha");

    const chats = await screen.findByRole("region", { name: "Chats" });
    const rows = await within(chats).findAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["/chat/a2", "/chat/a1"]);
    expect(within(rows[0]).getByText("Alpha newest")).toBeTruthy();
    const files = screen.getByRole("region", { name: "Files" });
    expect(
      (await within(files).findByRole("link", { name: "brief.md" })).getAttribute("href"),
    ).toBe("/files/alpha/brief.md");
    expect(within(files).getByRole("link", { name: "Open in Files" }).getAttribute("href")).toBe(
      "/files/alpha",
    );
  });

  it("says when each chat was last active in the dashboard's language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      renderAt("/projects/alpha");

      const chats = await screen.findByRole("region", { name: "对话" });
      const newest = (await within(chats).findAllByRole("link"))[0];
      const when = new Date("2026-07-09T00:00:00.000Z").toLocaleDateString("zh-CN", {
        month: "short",
        day: "numeric",
      });
      expect(within(newest).getByText(when)).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("starts a new chat in the project's folder", async () => {
    const user = userEvent.setup();
    renderAt("/projects/alpha");

    await user.click(await screen.findByRole("button", { name: "New chat" }));

    expect(JSON.parse(screen.getByTestId("location").textContent ?? "{}")).toEqual({
      pathname: "/chat",
      state: { projectPath: "alpha" },
    });
  });

  it("opens an old link to a file at the projects root in Files", async () => {
    renderAt("/projects/todo.md?line=3");

    expect(await screen.findByText(/"pathname":"\/files\/todo.md"/)).toBeTruthy();
  });

  it("shows no project page while an old root-file link is being checked", async () => {
    let openGate = () => {};
    resolveGate = new Promise((resolve) => {
      openGate = resolve;
    });
    renderAt("/projects/todo.md");

    // The project list has loaded and names no `todo.md`; the path check is pending.
    await rs.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            new URL(String(input), "http://localhost").pathname === "/api/projects/resolve",
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByText("todo.md")).toBeNull();

    openGate();
    expect(await screen.findByText(/"pathname":"\/files\/todo.md"/)).toBeTruthy();
  });

  it("keeps a folder's project page when its files fail to load", async () => {
    failingTrees.add("projects/loose");
    renderAt("/projects/loose");

    const files = await screen.findByRole("region", { name: "Files" });
    expect(await within(files).findByRole("alert")).toBeTruthy();
    expect(within(files).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/There's no project/)).toBeNull();
    expect(screen.getByText("No chats in this project yet")).toBeTruthy();
  });

  it("says a project is missing only when the projects root has no such folder", async () => {
    renderAt("/projects/nowhere");

    expect(await screen.findByText(/There's no project named “nowhere”/)).toBeTruthy();
  });

  it("checks a nested project's whole path, not just its top folder", async () => {
    renderAt(`/projects/${encodeURIComponent("alpha/nope")}`);

    expect(await screen.findByText(/There's no project named “alpha\/nope”/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  });

  it("says a project is missing when core rejects its name, with no retry", async () => {
    renderAt(`/projects/${encodeURIComponent("..")}`);

    expect(await screen.findByText(/There's no project named “\.\.”/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("previews a project's files folders first, by name, and only the first ten", async () => {
    extraRecords = [record("crowded")];
    renderAt("/projects/crowded");

    const files = await screen.findByRole("region", { name: "Files" });
    await within(files).findByRole("link", { name: "zeta" });
    const names = within(files)
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter((name) => name !== "Open in Files");
    expect(names).toEqual([
      "zeta",
      ...Array.from({ length: 9 }, (_, i) => `note-${String(i + 1).padStart(2, "0")}.md`),
    ]);
    expect(within(files).getByRole("link", { name: "Open in Files" })).toBeTruthy();
  });

  it("offers a retry when an unknown project's folder cannot be checked", async () => {
    resolveFails = true;
    renderAt("/projects/loose");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/There's no project/)).toBeNull();
  });

  it("does not reload the files when the chats change", async () => {
    renderAt("/projects/alpha");
    await screen.findByRole("link", { name: "brief.md" });
    const calls = (pathname: string) =>
      fetchMock.mock.calls.filter(
        ([input]) => new URL(String(input), "http://localhost").pathname === pathname,
      ).length;
    const sessionReads = calls("/api/chat/sessions");
    const treeReads = calls("/api/projects/tree");

    emitSessionsChanged();

    await rs.waitFor(() => expect(calls("/api/chat/sessions")).toBeGreaterThan(sessionReads));
    expect(calls("/api/projects/tree")).toBe(treeReads);
  });

  it("offers only a retry when the projects cannot be loaded", async () => {
    sessionsFail = true;
    renderAt("/projects/todo.md");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByText("todo.md")).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => new URL(String(input), "http://localhost").pathname === "/api/projects/tree",
      ),
    ).toBe(false);
  });
});
