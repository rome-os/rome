// Main-process bridge to the live EmailAdapter. Channel contract: docs/architecture/channels.md.
// The `email_inbound` action runs in a forked action worker, where the channel
// adapter map holds only RPC proxies — the real EmailAdapter (with its inbound
// secret, MailProvider, and onMessage pipeline) lives in the main process. This
// control resolves that adapter per call so an email channel enabled/disabled at
// runtime is always picked up, and tolerates "not running" so a deposit arriving
// while email is off is dropped cleanly rather than throwing.

export interface EmailInboundResult {
  status: "dispatched" | "rejected" | "skipped";
  reason?: string;
}

export interface EmailInboundControl {
  ingest(rawBody: string, signature: string): Promise<EmailInboundResult>;
}

interface IngestCapableAdapter {
  ingestInbound?: (rawBody: string, signature: string) => Promise<EmailInboundResult>;
}

export function createEmailInboundControl(ports: {
  getPort(name: string): unknown;
}): EmailInboundControl {
  return {
    async ingest(rawBody: string, signature: string): Promise<EmailInboundResult> {
      const adapter = ports.getPort("email") as IngestCapableAdapter | null;
      if (!adapter || typeof adapter.ingestInbound !== "function") {
        return { status: "skipped", reason: "channel_inactive" };
      }
      return adapter.ingestInbound(rawBody, signature);
    },
  };
}
