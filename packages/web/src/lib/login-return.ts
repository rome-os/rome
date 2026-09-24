// Where to go once sign-in succeeds. The auth gate sends a signed-out visitor
// to /login from whatever page they asked for; without this, every sign-in
// path lands on "/" and a home-screen shortcut to an app opens Rome's home
// page instead (an iOS home-screen web app does not share Safari's cookies, so
// its first launch always signs in).
//
// localStorage rather than sessionStorage: cloud sign-in leaves for Rome Cloud
// and comes back through /callback, and a home-screen web app is not
// guaranteed to keep sessionStorage across that round trip.
export const LOGIN_RETURN_STORAGE_KEY = "rome-login-return";

function isReturnablePath(path: string): boolean {
  // Same-origin paths only ("//host" is protocol-relative), never the sign-in
  // page itself.
  return (
    path.startsWith("/") && !path.startsWith("//") && path !== "/" && !path.startsWith("/login")
  );
}

/** Records the page a signed-out visitor asked for; "/" clears any earlier one. */
export function rememberLoginReturn(path: string): void {
  try {
    if (isReturnablePath(path)) {
      window.localStorage.setItem(LOGIN_RETURN_STORAGE_KEY, path);
    } else {
      window.localStorage.removeItem(LOGIN_RETURN_STORAGE_KEY);
    }
  } catch {
    // Unpersistable (private mode / quota): sign-in just lands on "/".
  }
}

/** The remembered page, or "/" when there is none. Leaves it in place. */
export function peekLoginReturn(): string {
  try {
    const path = window.localStorage.getItem(LOGIN_RETURN_STORAGE_KEY);
    return path !== null && isReturnablePath(path) ? path : "/";
  } catch {
    return "/";
  }
}

/** The remembered page, or "/" when there is none. Clears it either way. */
export function takeLoginReturn(): string {
  const path = peekLoginReturn();
  try {
    window.localStorage.removeItem(LOGIN_RETURN_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  return path;
}
