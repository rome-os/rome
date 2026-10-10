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

export function getFileBrowserUrlPath(logicalRootPath: string, path: string | null): string {
  if (!path || path === logicalRootPath) {
    return `/${logicalRootPath}`;
  }

  const relativePath = path.startsWith(`${logicalRootPath}/`)
    ? path.slice(logicalRootPath.length + 1)
    : path;
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return `/${logicalRootPath}/${encodedPath}`;
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
