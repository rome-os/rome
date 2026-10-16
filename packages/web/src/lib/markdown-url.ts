import { defaultUrlTransform, type MarkdownProps } from "@rome-os/ui/markdown";
import { getFileBrowserRouteLogicalPath } from "./file-browser-routing";
import { isInternalHref, toInternalPath } from "./internal-href";

export const transformMarkdownUrl: NonNullable<MarkdownProps["urlTransform"]> = (
  url,
  key,
  node,
) => {
  const transformedUrl = defaultUrlTransform(url, key, node);
  if (
    !transformedUrl ||
    key !== "src" ||
    node.tagName !== "img" ||
    !isInternalHref(transformedUrl)
  ) {
    return transformedUrl;
  }

  // File browser routes serve the dashboard HTML, not the image bytes.
  const pathname = toInternalPath(transformedUrl).split(/[?#]/, 1)[0];
  // `/files` is the page route for the `projects` root; agent-authored links
  // still address it as `/projects`.
  const match = /^\/(projects|files|memory)\/(.+)$/.exec(pathname);
  if (!match) return transformedUrl;

  const [, route, routePath] = match;
  const root = route === "files" ? "projects" : route;
  const logicalPath = getFileBrowserRouteLogicalPath(root, routePath);
  if (!logicalPath) return "";

  const fileName = logicalPath.slice(logicalPath.lastIndexOf("/") + 1);
  return `/api/${root}/asset/${encodeURIComponent(fileName)}?path=${encodeURIComponent(logicalPath)}`;
};
