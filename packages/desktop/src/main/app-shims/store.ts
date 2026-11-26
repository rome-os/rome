import { z } from "zod";

/** The settings key holding the Rome apps this computer put on its Desktop. */
export const APP_SHIMS_KEY = "appShims";

const recordSchema = z.object({
  /** The suffix of the shim's bundle id. */
  installId: z.string().regex(/^[0-9a-f]{12}$/),
  appId: z.string().min(1),
  /** The page the shim's window opens: the app's full-screen route on the Rome it came from. */
  url: z.string().url(),
  name: z.string().min(1),
  bundlePath: z.string().min(1),
  /** The code directory hash of the signed bundle; a connecting shim must match it. */
  cdhash: z.string().regex(/^[0-9a-f]{40}$/),
});

export type AppShimRecord = z.infer<typeof recordSchema>;

export interface SettingsAccess {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** The saved records; anything unreadable is dropped rather than trusted. */
export function readAppShims(settings: SettingsAccess): AppShimRecord[] {
  const raw = settings.read(APP_SHIMS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const record = recordSchema.safeParse(item);
      return record.success ? [record.data] : [];
    });
  } catch {
    return [];
  }
}

/** Saves `record`, replacing the one for the same bundle path or install. */
export function saveAppShim(settings: SettingsAccess, record: AppShimRecord): void {
  const rest = readAppShims(settings).filter(
    (r) => r.installId !== record.installId && r.bundlePath !== record.bundlePath,
  );
  settings.write(APP_SHIMS_KEY, JSON.stringify([...rest, record]));
}
