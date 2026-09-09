import { useContext } from "react";
import { MarkdownLink, MARKDOWN_LINK_CLASS, type MarkdownLinkProps } from "@/components/markdown";
import { resolveAppToOpen } from "@/lib/chat-helpers";
import { decodeFileBrowserRoutePath } from "@/lib/file-browser-routing";
import { autoPlaceApp } from "@/pages/free/use-free-cells";
import { useWorkspaceEventBus } from "@/pages/free/workspace-event-bus";
import { WorkspaceStoreContext } from "@/pages/free/workspace-store";

// The link renderer for markdown rendered inside the chat workspace. It keeps
// the generic Markdown component workspace-agnostic: the special-casing for the
// two link shapes the agent emits lives here, and everything else falls through
// to the default react-router link.
//
//   /projects/<project>/<path>  → open the projects panel + select the file
//                                 (reuses the same follow signal ChatWidget
//                                 publishes when an agent links a file).
//   /apps/<appId>[/<route>][?q]  → open that app's workspace tile, preserving
//                                 the in-app sub-route and query params so the
//                                 tile lands on the exact linked page.
//
// Both reuse the exact mechanisms FreeGrid already drives for agent-linked
// files and installed apps, just triggered by an explicit click.

function isProjectsHref(href: string): boolean {
  return href === "/projects" || href.startsWith("/projects/");
}

// The markdown pipeline percent-encodes hrefs (micromark's normalizeUri), so a
// non-ASCII or spaced filename arrives as `/projects/default/%E9%A2%9E….docx`.
// The follow signal carries *logical* file paths — the resolve endpoint would
// look up the percent-encoded name verbatim, miss, and leave the panel on the
// bare tree. Delegate to the full-page route's decoder so a chat click and the
// same URL in a new tab always land on the same target; null means the encoded
// form is invalid under the route's rules (bad %, %2F, %2E%2E) and the caller
// falls back to the verbatim href, which /resolve then misses — the same bare
// tree the full page shows for that URL.
function decodeProjectsHref(href: string): string | null {
  if (href === "/projects") return href;
  const decoded = decodeFileBrowserRoutePath(href.slice("/projects/".length));
  return decoded === null ? null : `/projects/${decoded}`;
}

// /apps/<appId>[/<route...>][?query]. `route` rides the iframe src path
// (`/full/apps/<id>/<route>`) and `params` the query — see use-free-cells. The
// AppsIndex page (`/apps` with no segment) is left to react-router.
function parseAppHref(
  href: string,
): { appId: string; route?: string; params?: Record<string, string> } | null {
  const match = /^\/apps\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?/.exec(href);
  if (!match) return null;
  const appId = decodeURIComponent(match[1]);
  const route = match[2] ? match[2] : undefined;
  let params: Record<string, string> | undefined;
  if (match[3]) {
    const entries = [...new URLSearchParams(match[3])];
    if (entries.length > 0) params = Object.fromEntries(entries);
  }
  return { appId, route, params };
}

// Renders the workspace link as a real anchor (so Cmd/Ctrl/middle-click still
// open the full page in a new tab) but intercepts a plain left-click to run the
// workspace action. Drops Streamdown's injected target/rel so a plain click
// doesn't also navigate.
function WorkspaceLink({
  children,
  href,
  node: _node,
  target: _target,
  rel: _rel,
  className: _className,
  ref: _ref,
  onActivate,
  ...rest
}: MarkdownLinkProps & { onActivate: () => void }) {
  return (
    <a
      href={href}
      className={MARKDOWN_LINK_CLASS}
      onClick={(e) => {
        if (
          e.defaultPrevented ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          e.button !== 0
        )
          return;
        e.preventDefault();
        onActivate();
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function ChatLink(props: MarkdownLinkProps) {
  // Defensive: read the store via context (not the throwing hook) so ChatLink
  // is safe even if a chat block is ever rendered outside the workspace — it
  // just degrades to the default react-router link.
  const store = useContext(WorkspaceStoreContext);
  const eventBus = useWorkspaceEventBus();
  const href = props.href;

  if (store && href) {
    if (isProjectsHref(href)) {
      return (
        <WorkspaceLink
          {...props}
          onActivate={() => {
            const path = decodeProjectsHref(href) ?? href;
            // `force` bypasses the user's manual close of the panel — an
            // explicit click is an explicit request to see the file.
            eventBus?.emit("projects:opened", { paths: [path], force: true });
            store.set("followTargetPath", path);
          }}
        />
      );
    }
    const app = parseAppHref(href);
    if (app) {
      return (
        <WorkspaceLink
          {...props}
          onActivate={() => autoPlaceApp(resolveAppToOpen(app.appId), app.route, app.params, true)}
        />
      );
    }
  }

  return <MarkdownLink {...props} />;
}
