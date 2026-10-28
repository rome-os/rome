import type { ApiConnection } from "@/lib/connections-api";
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";

// The connection ledger. In its own module because two surfaces read it and one
// of them writes it: the Connections page revokes a grant, and the send routes
// behind that channel have to notice. Keeping it in `index.ts` would have meant
// `people.ts` importing the module that imports it.
//
// Every card reads its state from `state`, never from `capabilities`: a
// connection with no state renders "Not connected" however unlocked its
// capabilities claim to be. Each entry below therefore carries the working
// state its ceremony would have left, or the Connections page would contradict
// the surfaces these fixtures feed — the People page's WhatsApp contacts, and
// the configured Discord and Telegram conversations below.
export const connections: { connections: ApiConnection[] } = {
  connections: [
    {
      id: "github-demo",
      connectionKind: "github",
      label: "GitHub · Rome Demo",
      state: "working",
      grants: { user: "authorized" },
      display: {
        user: { displayName: "Rome Demo", handle: "rome-demo", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unsupported" },
        act: { state: "unlocked" },
        watch: { state: "unlocked" },
      },
      connect: null,
      setups: {},
      channel: null,
      agent: null,
      link: null,
      severalAccounts: false,
    },
    ...[
      {
        service: "email",
        label: "Email",
        grant: "inbox",
        email: "guardian@example.com",
        severalAccounts: false,
      },
      { service: "wechat", label: "WeChat", grant: "account", email: null, severalAccounts: false },
      { service: "feishu", label: "Feishu", grant: "bot", email: null, severalAccounts: true },
    ].map(
      ({ service, label, grant, email, severalAccounts }): ApiConnection => ({
        id: `${service}-demo`,
        connectionKind: service,
        label: `${label} · Rome Demo`,
        state: "working",
        grants: { [grant]: "authorized" },
        display: {
          [grant]: { displayName: "Rome Demo", handle: null, email, avatarUrl: null },
        },
        capabilities: {
          chat: { state: "unlocked" },
          act: { state: "unsupported" },
          watch: { state: "unsupported" },
        },
        connect: null,
        setups: {},
        channel: service,
        // Core links main to every existing linkable bot on upgrade.
        agent: service === "feishu" ? MAIN_AGENT_ID : null,
        link: service === "feishu" ? "own_account" : null,
        severalAccounts,
      }),
    ),
    {
      id: "discord-1",
      connectionKind: "discord",
      label: "Discord · Rome",
      state: "working",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: "rome#4417", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "discord",
      agent: MAIN_AGENT_ID,
      link: "own_account",
      severalAccounts: true,
    },
    {
      id: "telegram-1",
      connectionKind: "telegram",
      label: "Telegram · Rome",
      state: "working",
      grants: { bot: "authorized" },
      display: {
        bot: { displayName: "Rome", handle: "@rome_guardian_bot", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "telegram",
      agent: MAIN_AGENT_ID,
      link: "own_account",
      severalAccounts: true,
    },
    {
      // The channel behind the People page's WhatsApp section: the address-book
      // mirror those contacts come from only exists while a session is linked,
      // so dropping this entry would leave the two surfaces disagreeing about
      // whether WhatsApp is connected at all.
      id: "whatsapp-1",
      connectionKind: "whatsapp",
      label: "WhatsApp · Rome",
      state: "working",
      grants: { session: "authorized" },
      display: {
        session: { displayName: "Rome", handle: "+1 (415) 555-0100", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "whatsapp",
      agent: null,
      link: null,
      severalAccounts: false,
    },
    {
      id: "linkedin-1",
      connectionKind: "linkedin",
      label: "LinkedIn · Rome",
      state: "working",
      grants: { session: "authorized" },
      display: {
        session: { displayName: "Rome", handle: "rome-guardian", email: null, avatarUrl: null },
      },
      capabilities: {
        chat: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      connect: null,
      setups: {},
      channel: "linkedin",
      agent: null,
      link: null,
      severalAccounts: false,
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
      connection.connectionKind === service && connection.capabilities.chat.state === "unlocked",
  );
}
