import type { ReactNode } from "react";
import { TimestampProvider } from "@rome-os/ui/timestamp";
import { useSettings } from "@/hooks/use-settings";

/** Mounts the kit's `TimestampProvider` with the guardian's configured zone
 * (the `guardianTimezone` setting, the same one the routine scheduler
 * resolves floating schedules against). While settings load, or when no zone
 * is stored, every `Timestamp` renders in the browser's zone. */
export function GuardianTimestampProvider({ children }: { children: ReactNode }) {
  const { data } = useSettings();
  const timeZone = data?.guardianTimezone;
  return (
    <TimestampProvider timeZone={typeof timeZone === "string" ? timeZone : undefined}>
      {children}
    </TimestampProvider>
  );
}
