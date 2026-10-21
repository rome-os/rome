/**
 * Live channel connection status from the host's same-origin endpoint, so the
 * settings UI can warn when a chosen delivery channel isn't connected yet.
 * Email always routes through Rome's mail channel, so it's treated as ready.
 */

export interface ChannelConnectivity {
  email: boolean;
  whatsapp: boolean;
}

interface HostConnection {
  connectionKind?: string;
  /** The kind of connection, as a host from before the rename names it. */
  service?: string;
  grants?: Record<string, string>;
}

export async function fetchChannelConnectivity(): Promise<ChannelConnectivity | null> {
  try {
    const res = await fetch("/api/connections", { credentials: "include" });
    if (!res.ok) return null;
    const data = (await res.json()) as { connections?: HostConnection[] };
    const whatsapp = data.connections?.find((c) => (c.connectionKind ?? c.service) === "whatsapp");
    // Conferred (authorized or degraded) counts as set up — mirrors the
    // dashboard's registry-native "configured" reading.
    const conferred = Object.values(whatsapp?.grants ?? {}).some(
      (state) => state !== "unauthorized",
    );
    return {
      email: true,
      whatsapp: conferred,
    };
  } catch {
    return null;
  }
}
