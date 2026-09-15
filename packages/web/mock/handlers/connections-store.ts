import type { ApiConnection } from "@/lib/connections-api";

// The connection ledger. In its own module because two surfaces read it and one
// of them writes it: the Connections page revokes a grant, and the send routes
// behind that channel have to notice. Keeping it in `index.ts` would have meant
// `people.ts` importing the module that imports it.
//
// Every card reads its state from `grants`, never from `capabilities`: a
// connection with an empty grant map renders "Not connected" however unlocked
// its capabilities claim to be. Each entry below therefore carries the grant
// its ceremony would have conferred, or the Connections page would contradict
// the surfaces these fixtures feed — the People page's WhatsApp contacts, and
// the configured Discord and Telegram conversations below.
export const connections: { connections: ApiConnection[] } = {
  connections: [
    {
      id: "github-demo",
      service: "github",
      label: "GitHub · Rome Demo",
      grants: { user: "authorized" },
      display: {
        user: { displayName: "Rome Demo", handle: "rome-demo", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unsupported" },
        act: { state: "unlocked" },
        watch: { state: "unlocked" },
      },
      connect: null,
    },
    ...[
      { service: "email", label: "Email", grant: "inbox", email: "guardian@example.com" },
      { service: "wechat", label: "WeChat", grant: "account", email: null },
      { service: "feishu", label: "Feishu", grant: "bot", email: null },
    ].map(
      ({ service, label, grant, email }): ApiConnection => ({
        id: `${service}-demo`,
        service,
        label: `${label} · Rome Demo`,
        grants: { [grant]: "authorized" },
        display: {
          [grant]: { displayName: "Rome Demo", handle: null, email, avatarUrl: null },
        },
        capabilities: {
          talk: { state: "unlocked" },
          act: { state: "unsupported" },
          watch: { state: "unsupported" },
        },
        connect: null,
      }),
    ),
    {
      id: "discord-1",
      service: "discord",
      label: "Discord · Rome",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: "rome#4417", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
    },
    {
      id: "telegram-1",
      service: "telegram",
      label: "Telegram · Rome",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: "@rome_guardian_bot", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
    },
    {
      // The channel behind the People page's WhatsApp section: the address-book
      // mirror those contacts come from only exists while a session is linked,
      // so dropping this entry would leave the two surfaces disagreeing about
      // whether WhatsApp is connected at all.
      id: "whatsapp-1",
      service: "whatsapp",
      label: "WhatsApp · Rome",
      grants: { session: "authorized" },
      display: {
        session: { displayName: "Rome", handle: "+1 (415) 555-0100", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
    },
    {
      id: "linkedin-1",
      service: "linkedin",
      label: "LinkedIn · Rome",
      grants: { session: "authorized" },
      display: {
        session: { displayName: "Rome", handle: "rome-guardian", email: null, avatarUrl: null },
      },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
    },
  ],
};

/**
 * The talk transports a service currently has, mirroring the `talkRouter.list()`
 * filter the send routes run. A revoked grant relocks `talk`, so a disconnected
 * channel drops out of this list and its send route refuses, the way the real
 * one does.
 */
export function talkConnections(service: string): ApiConnection[] {
  return connections.connections.filter(
    (connection) =>
      connection.service === service && connection.capabilities.talk.state === "unlocked",
  );
}
