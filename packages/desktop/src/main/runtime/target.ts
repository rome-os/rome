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
 * Which Rome the app opens. `local` boots the private VM on this computer.
 * `remote` opens a hosted Rome from the user's Rome Cloud account; its
 * `instance` is null until one is picked, which is also the signed-out state
 * a new install starts in.
 */
export type RuntimeTarget =
  | { kind: "local" }
  | { kind: "remote"; instance: RemoteInstanceRef | null };

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  origin: z.string().refine((value) => exactHttpsOrigin(value) === value),
});

const targetSchema = z.union([
  z.object({ kind: z.literal("local") }),
  z.object({ kind: z.literal("remote"), instance: instanceSchema.nullable() }),
]);

/**
 * The saved target, or the default for a computer that never saved one: the
 * VM when it already has one (an install from before Rome Cloud mode, whose
 * Rome lives there), Rome Cloud sign-in otherwise.
 */
export function parseRuntimeTarget(raw: string | null, hasLocalRuntime: boolean): RuntimeTarget {
  const fallback: RuntimeTarget = hasLocalRuntime
    ? { kind: "local" }
    : { kind: "remote", instance: null };
  if (!raw) return fallback;
  try {
    const parsed = targetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Validates a target arriving over IPC; throws on anything malformed. */
export function requireRuntimeTarget(value: unknown): RuntimeTarget {
  return targetSchema.parse(value);
}

export function sameTarget(a: RuntimeTarget, b: RuntimeTarget): boolean {
  if (a.kind === "local" || b.kind === "local") return a.kind === b.kind;
  return (a.instance?.id ?? null) === (b.instance?.id ?? null);
}
