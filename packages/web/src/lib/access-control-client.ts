export interface SessionHandoffPayload {
  token: string;
  next: string;
}

export function accessControlChecksPassed(
  httpsEnabled: boolean | null,
  tailnetReachable: boolean,
): boolean {
  return httpsEnabled === true && tailnetReachable;
}

export function describeTailscaleCertError(certError: string | null): string | null {
  if (!certError) {
    return null;
  }

  if (certError === "domain_not_cert_eligible") {
    return "Tailscale cannot issue a TLS certificate for this device yet. Enable MagicDNS and HTTPS certificates in the Tailscale admin console, then reconnect this machine if needed.";
  }

  return "Tailscale HTTPS is configured, but the TLS certificate could not be issued automatically. Check your Tailscale DNS settings, then try again.";
}

export async function probeTailnetReachable(targetHost: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`https://${targetHost}/api/health`, {
      signal: controller.signal,
      mode: "cors",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestSessionHandoff(
  targetHost: string,
  nextPath: string,
): Promise<SessionHandoffPayload | null> {
  const response = await fetch("/api/auth/handoff-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetHost, next: nextPath }),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as SessionHandoffPayload;
  return { token: data.token, next: data.next };
}

export function submitSessionHandoff(targetHost: string, handoff: SessionHandoffPayload): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `https://${targetHost}/api/auth/handoff`;
  form.style.display = "none";

  const tokenInput = document.createElement("input");
  tokenInput.type = "hidden";
  tokenInput.name = "token";
  tokenInput.value = handoff.token;
  form.appendChild(tokenInput);

  const nextInput = document.createElement("input");
  nextInput.type = "hidden";
  nextInput.name = "next";
  nextInput.value = handoff.next;
  form.appendChild(nextInput);

  document.body.appendChild(form);
  form.submit();
}
