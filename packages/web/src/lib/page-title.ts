// The document title every route composes. A title is the tab's hover tooltip,
// the bookmark name, and the history entry, so each one names the page rather
// than the instance.

/** Trailing segment on every title. Matches `og:site_name` in index.html. */
const SITE_NAME = "Rome";

/** Separator between segments. Matches the shared-chat title SharePage renders. */
const SEPARATOR = " · ";

// A guardian-authored name — a chat session, a person, a file — has no length
// limit, and a tab tooltip that wraps to five lines names nothing. The cut is
// per segment, so a long leading name cannot push SITE_NAME out of view.
const MAX_SEGMENT_LENGTH = 60;
const ELLIPSIS = "…";

function truncate(segment: string): string {
  return segment.length <= MAX_SEGMENT_LENGTH
    ? segment
    : `${segment.slice(0, MAX_SEGMENT_LENGTH - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * Joins `segments` most-specific-first and appends the site name:
 * composeTitle(["Connections", "Settings"]) returns "Connections · Settings · Rome".
 * Empty and nullish segments are dropped, and a list with no names returns the
 * site name alone, so a route that names nothing still reads as Rome.
 */
export function composeTitle(segments: readonly (string | null | undefined)[]): string {
  const named = segments
    .filter((segment): segment is string => typeof segment === "string")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(truncate);
  return [...named, SITE_NAME].join(SEPARATOR);
}

// The title the server rendered into the shell before React mounted, and the
// path it was rendered for. Read once at module load: by the time a page's
// effect runs, the shell may already have replaced document.title with the
// route's own name.
const INITIAL_TITLE = typeof document === "undefined" ? "" : document.title;
const INITIAL_PATHNAME = typeof window === "undefined" ? "" : window.location.pathname;

/**
 * The name the server put in `<title>` for `pathname`, or null when this is not
 * the path the document was loaded at, or the server named nothing. A page that
 * resolves its own name asynchronously holds this in the meantime, so a direct
 * load does not flash the route's name between first paint and the response.
 */
export function serverRenderedName(pathname: string): string | null {
  if (pathname !== INITIAL_PATHNAME) return null;
  const suffix = `${SEPARATOR}${SITE_NAME}`;
  if (!INITIAL_TITLE.endsWith(suffix)) return null;
  const name = INITIAL_TITLE.slice(0, -suffix.length).trim();
  return name.length > 0 ? name : null;
}

/**
 * A destination the guardian can navigate to by name. Structural on purpose:
 * the caller passes the nav registry it already holds, so no second list of
 * routes exists to drift from the first.
 */
export interface TitledDestination {
  href: string;
  labelKey: string;
}

// The two routes whose whole subject is a path in a tree. Their pages render a
// file browser that keeps the open file in the URL, so the route can name it
// without the page reporting anything.
const FILE_BROWSER_PREFIXES = ["/memory", "/projects"];

export interface RouteTitle {
  /** Key into the `common` namespace naming the destination. */
  key: string;
  /** The open file or folder on a file-browser route, else null. */
  detail: string | null;
}

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function fileBrowserDetail(pathname: string): string | null {
  const prefix = FILE_BROWSER_PREFIXES.find((candidate) => pathname.startsWith(`${candidate}/`));
  if (prefix === undefined) return null;
  const segments = pathname.slice(prefix.length + 1).split("/");
  const last = segments[segments.length - 1];
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    // A malformed escape is the address bar's problem, not the title's.
    return last;
  }
}

/**
 * What `pathname` is called according to `destinations`, or null when none of
 * them owns it — a page outside the nav names itself through useDocumentTitle,
 * and the auth screens keep the bare site name.
 *
 * The longest matching href wins, so /apps/store beats /apps whatever order
 * the registry is written in. Matching is on segment boundaries, so /peopled
 * never resolves to /people.
 */
export function routeTitle(
  pathname: string,
  destinations: readonly TitledDestination[],
): RouteTitle | null {
  let best: TitledDestination | null = null;
  for (const destination of destinations) {
    if (!matches(pathname, destination.href)) continue;
    if (best === null || destination.href.length > best.href.length) best = destination;
  }
  if (best === null) return null;
  return { key: best.labelKey, detail: fileBrowserDetail(pathname) };
}
