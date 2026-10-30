import { exactHttpsOrigin } from "@rome-os/libs/native-auth";
import { z } from "zod";

/** The settings key that picks which Rome the main window opens. */
export const RUNTIME_TARGET_KEY = "runtime.target";

export interface RemoteInstanceRef {
  id: string;
  name: string;
  origin: string;
}

/**
 * Which Rome the app opens: a hosted Rome from the user's Rome Cloud account.
 * `instance` is null until one is picked, which is also the signed-out state
 * a new install starts in.
 */
export interface RuntimeTarget {
  kind: "remote";
  instance: RemoteInstanceRef | null;
}

const SIGN_IN: RuntimeTarget = { kind: "remote", instance: null };

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  origin: z.string().refine((value) => exactHttpsOrigin(value) === value),
});

const targetSchema = z.object({ kind: z.literal("remote"), instance: instanceSchema.nullable() });

/**
 * The saved target, or Rome Cloud sign-in for anything else. That includes
 * `{"kind":"local"}`, which builds that ran a private VM on this computer
 * saved: the app no longer runs one, so those installs land on sign-in.
 */
export function parseRuntimeTarget(raw: string | null): RuntimeTarget {
  if (!raw) return SIGN_IN;
  try {
    const parsed = targetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : SIGN_IN;
  } catch {
    return SIGN_IN;
  }
}

/** Validates a target arriving over IPC; throws on anything malformed. */
export function requireRuntimeTarget(value: unknown): RuntimeTarget {
  return targetSchema.parse(value);
}

export function sameTarget(a: RuntimeTarget, b: RuntimeTarget): boolean {
  return (a.instance?.id ?? null) === (b.instance?.id ?? null);
}
