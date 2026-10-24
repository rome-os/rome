import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { shouldSecureCookie } from "./auth.js";

// Binds an OAuth sign-in attempt to the browser that started it. The start
// route sets the attempt's state in this cookie, and the callback accepts the
// state only when the cookie carries it, so a callback URL started in one
// browser can't finish a sign-in in another (login CSRF). Over HTTPS the
// cookie takes the `__Host-` prefix, so a sibling subdomain can't plant one.

export function setAttemptCookie(c: Context, name: string, state: string, ttlMs: number): void {
  const secure = shouldSecureCookie(c.req.raw);
  setCookie(c, name, state, {
    httpOnly: true,
    secure,
    // Lax still sends it on Rome Cloud's top-level redirect back to the callback.
    sameSite: "Lax",
    path: "/",
    maxAge: ttlMs / 1000,
    ...(secure && { prefix: "host" as const }),
  });
}

export function readAttemptCookie(c: Context, name: string): string | undefined {
  return shouldSecureCookie(c.req.raw) ? getCookie(c, name, "host") : getCookie(c, name);
}

export function clearAttemptCookie(c: Context, name: string): void {
  const secure = shouldSecureCookie(c.req.raw);
  deleteCookie(c, name, {
    path: "/",
    secure,
    ...(secure && { prefix: "host" as const }),
  });
}
