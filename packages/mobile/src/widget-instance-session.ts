import { exactHttpsOrigin, type InstanceSession } from "@rome-os/libs/native-auth";

export interface WidgetInstanceSession {
  version: 1;
  origin: string;
  cookieName: "rome_session";
  token: string;
  expiresAt: string;
}

function validSessionToken(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && !value.includes(";") && !/[\r\n]/.test(value)
  );
}

export function parseWidgetInstanceSession(raw: string | null): WidgetInstanceSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WidgetInstanceSession>;
    const origin = exactHttpsOrigin(value.origin);
    const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
    if (
      value.version !== 1 ||
      value.cookieName !== "rome_session" ||
      !origin ||
      origin !== value.origin ||
      !validSessionToken(value.token) ||
      !Number.isFinite(expiresAt)
    ) {
      return null;
    }
    return value as WidgetInstanceSession;
  } catch {
    return null;
  }
}

export function createWidgetInstanceSession(
  session: InstanceSession,
  now: number = Date.now(),
): WidgetInstanceSession | null {
  const origin = exactHttpsOrigin(session.origin);
  const expiresAt = Date.parse(session.expiresAt);
  if (
    session.cookieName !== "rome_session" ||
    !origin ||
    origin !== session.origin ||
    !validSessionToken(session.token) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    return null;
  }
  return {
    version: 1,
    origin,
    cookieName: "rome_session",
    token: session.token,
    expiresAt: session.expiresAt,
  };
}
