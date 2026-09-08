import { http, HttpResponse, type HttpHandler } from "msw";
import type {
  BrowserFile,
  HistoryEntry,
  ResolveResult,
  SearchResult,
} from "@/components/file-browser/store/types";
import type { FileBrowserTreeNode } from "@/lib/file-browser-tree";

/**
 * The in-memory filesystem behind a file-browser surface — `/api/projects` and
 * `/api/memory` are the same routes over two different roots, so both are
 * served from one factory here.
 *
 * The store is mutable, the way the rest of mock mode's writes are: saving a
 * file, creating one, renaming, moving and deleting all change what the next
 * read returns. Editing a memory profile and navigating away therefore keeps
 * the edit, which is what makes the autosave path on `MemoryPage` reachable.
 *
 * Everything in it is text. A fixture tree has no bytes behind it, so the
 * asset, download and upload routes — the three that only exist to move real
 * bytes — are out of scope, and upload answers with that rather than
 * pretending.
 */
export interface MockFsNode {
  children?: MockFsNode[];
  /** File bodies only; a directory ignores it. */
  content?: string;
  name: string;
  path: string;
  type: "file" | "directory";
}

/** Convenience constructors, so a fixture tree reads as a directory listing
 *  instead of a wall of repeated `path`/`type` keys. */
export function dir(path: string, children: MockFsNode[]): MockFsNode {
  return { children, name: baseName(path), path, type: "directory" };
}

export function file(path: string, content: string): MockFsNode {
  return { content, name: baseName(path), path, type: "file" };
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parentPathOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function findNode(nodes: MockFsNode[], path: string): MockFsNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const match = node.children ? findNode(node.children, path) : undefined;
    if (match) return match;
  }
  return undefined;
}

function collectFiles(nodes: MockFsNode[]): MockFsNode[] {
  return nodes.flatMap((node) =>
    node.type === "file" ? [node] : collectFiles(node.children ?? []),
  );
}

/**
 * The fixture nests every level inline, but the real /tree honors `depth` —
 * the store loads the root at depth 2 and each expanded folder at depth 1, so
 * serving the full subtree would make lazy-per-level loading untestable here.
 * A directory at the depth limit comes back with no `children` key at all,
 * which is what the store reads as "not loaded yet".
 */
function toTreeNodes(nodes: MockFsNode[], depth: number): FileBrowserTreeNode[] {
  return nodes.map(({ name, path, type, children }) => {
    if (type !== "directory") return { name, path, type };
    if (depth <= 1) return { name, path, type };
    return { name, path, type, children: toTreeNodes(children ?? [], depth - 1) };
  });
}

function browserFile(node: MockFsNode): BrowserFile {
  const content = node.content ?? "";
  return {
    assetUrl: null,
    content,
    editable: true,
    kind: "text",
    mimeType: node.path.endsWith(".md") ? "text/markdown" : "text/plain",
    path: node.path,
    size: new TextEncoder().encode(content).length,
  };
}

export interface FileBrowserFixtureOptions {
  /** e.g. "/api/memory" — the routes the surface's store fetches. */
  apiBasePath: string;
  /** e.g. "memory" — the path prefix every node in `tree` carries. */
  logicalRoot: string;
  tree: MockFsNode[];
}

export function fileBrowserHandlers({
  apiBasePath,
  logicalRoot,
  tree,
}: FileBrowserFixtureOptions): HttpHandler[] {
  /** The list a path's node lives in, or would live in once created. */
  const siblingsOf = (path: string): MockFsNode[] | null => {
    const parentPath = parentPathOf(path);
    if (!parentPath || parentPath === logicalRoot) return tree;
    const parent = findNode(tree, parentPath);
    if (!parent || parent.type !== "directory") return null;
    parent.children ??= [];
    return parent.children;
  };

  /** Re-path a moved or renamed node's whole subtree. */
  const repath = (node: MockFsNode, nextPath: string): void => {
    node.path = nextPath;
    node.name = baseName(nextPath);
    for (const child of node.children ?? []) {
      repath(child, `${nextPath}/${child.name}`);
    }
  };

  const detach = (path: string): MockFsNode | null => {
    const siblings = siblingsOf(path);
    const index = siblings?.findIndex((node) => node.path === path) ?? -1;
    if (!siblings || index < 0) return null;
    return siblings.splice(index, 1)[0] ?? null;
  };

  const notFound = () => HttpResponse.json({ error: "not found" }, { status: 404 });

  return [
    http.get(`${apiBasePath}/tree`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const path = params.get("path");
      const requestedDepth = Number(params.get("depth"));
      const depth = Number.isFinite(requestedDepth) && requestedDepth > 0 ? requestedDepth : 1;
      const nodes = !path || path === logicalRoot ? tree : (findNode(tree, path)?.children ?? []);
      return HttpResponse.json(toTreeNodes(nodes, depth));
    }),
    // useUrlSelectionSync resolves the URL's path on load, so without this a
    // deep link to a file 404s before anything renders. It is also how the
    // dossier's "Memory profile" link opens a person's profile.
    http.get(`${apiBasePath}/resolve`, ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      const node = findNode(tree, path);
      if (path === logicalRoot) {
        return HttpResponse.json({ type: "directory", path } satisfies ResolveResult);
      }
      if (!node) return HttpResponse.json({ type: "missing", path } satisfies ResolveResult);
      if (node.type === "directory") {
        return HttpResponse.json({ type: "directory", path: node.path } satisfies ResolveResult);
      }
      const { assetUrl, editable, kind, mimeType, size } = browserFile(node);
      return HttpResponse.json({
        type: "file",
        path: node.path,
        assetUrl,
        editable,
        kind,
        mimeType,
        size,
      } satisfies ResolveResult);
    }),
    http.get(`${apiBasePath}/file`, ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      const node = findNode(tree, path);
      if (!node || node.type !== "file") return notFound();
      return HttpResponse.json(browserFile(node));
    }),
    // The save the editor autosaves through. Keeping the write means a reopened
    // file shows what was typed into it rather than the fixture body.
    http.put(`${apiBasePath}/file`, async ({ request }) => {
      const body = (await request.json()) as { content: string; path: string };
      const node = findNode(tree, body.path);
      if (!node || node.type !== "file") return notFound();
      node.content = body.content;
      return HttpResponse.json({ message: "Saved" });
    }),
    http.post(`${apiBasePath}/file`, async ({ request }) => {
      // Drag-and-drop upload posts multipart instead of JSON. There are no
      // bytes behind this tree, so it refuses rather than inventing a file.
      if (!request.headers.get("content-type")?.includes("application/json")) {
        return HttpResponse.json({ error: "Upload isn't mocked." }, { status: 501 });
      }
      const body = (await request.json()) as { path: string; type: "file" | "folder" };
      const siblings = siblingsOf(body.path);
      if (!siblings) return notFound();
      if (findNode(tree, body.path)) {
        return HttpResponse.json({ error: "Already exists." }, { status: 409 });
      }
      siblings.push(body.type === "folder" ? dir(body.path, []) : file(body.path, ""));
      return HttpResponse.json({ path: body.path });
    }),
    // One route, two writes: `name` renames in place, `parentPath` moves.
    http.patch(`${apiBasePath}/file`, async ({ request }) => {
      const body = (await request.json()) as {
        name?: string;
        parentPath?: string;
        path: string;
      };
      const source = findNode(tree, body.path);
      if (!source) return notFound();
      const targetParent = body.name ? parentPathOf(body.path) : (body.parentPath ?? logicalRoot);
      const nextPath = `${targetParent}/${body.name ?? source.name}`;
      if (nextPath === body.path) return HttpResponse.json({ path: body.path });
      if (findNode(tree, nextPath)) {
        return HttpResponse.json({ error: "Already exists." }, { status: 409 });
      }
      const siblings = siblingsOf(nextPath);
      if (!siblings) return notFound();
      const node = detach(body.path);
      if (!node) return notFound();
      repath(node, nextPath);
      siblings.push(node);
      return HttpResponse.json({ path: nextPath });
    }),
    http.delete(`${apiBasePath}/file`, ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      return detach(path) ? HttpResponse.json({ message: "Deleted" }) : notFound();
    }),
    http.get(`${apiBasePath}/search`, ({ request }) => {
      const query = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? "";
      if (!query) return HttpResponse.json([] as SearchResult[]);
      const results = collectFiles(tree).flatMap((node) => {
        const lines = (node.content ?? "").split("\n");
        const index = lines.findIndex((line) => line.toLowerCase().includes(query));
        if (index < 0 && !node.path.toLowerCase().includes(query)) return [];
        return [{ content: lines[Math.max(index, 0)] ?? "", file: node.path, line: index + 1 }];
      });
      return HttpResponse.json(results);
    }),
    // The fixture tree has no git behind it, so history is legitimately empty.
    http.get(`${apiBasePath}/history`, () => HttpResponse.json([] as HistoryEntry[])),
    // Keep the file-browser watch EventSource connected without emitting events.
    http.get(`${apiBasePath}/events`, () => {
      const stream = new ReadableStream({ start() {} });
      return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
    }),
  ];
}
