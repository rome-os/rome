export function decodeFileBrowserRoutePath(routePath: string | undefined): string | null {
  if (!routePath) return null;

  const normalizedPath = routePath.replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) return null;

  let segments: string[];
  try {
    segments = normalizedPath.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    return null;
  }

  return segments.join("/");
}

export function getFileBrowserRouteLogicalPath(
  logicalRootPath: string,
  routePath: string | undefined,
): string | null {
  const decodedPath = decodeFileBrowserRoutePath(routePath);
  return decodedPath ? `${logicalRootPath}/${decodedPath}` : null;
}

/**
 * The page URL for a logical path. The route usually shares the logical root's
 * name, but need not: the Files page browses the `projects` root at `/files`.
 */
export function getFileBrowserUrlPath(
  logicalRootPath: string,
  path: string | null,
  routeBasePath = `/${logicalRootPath}`,
): string {
  if (!path || path === logicalRootPath) {
    return routeBasePath;
  }

  const relativePath = path.startsWith(`${logicalRootPath}/`)
    ? path.slice(logicalRootPath.length + 1)
    : path;
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${routeBasePath}/${encodedPath}`;
}

export function getFileBrowserDirectoryAncestors(path: string, logicalRootPath: string): string[] {
  if (path === logicalRootPath || !path.startsWith(`${logicalRootPath}/`)) {
    return [];
  }

  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length - 1; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join("/"));
  }
  return ancestors;
}
