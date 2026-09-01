// Built-in connection integrations. `registerBuiltinConnections` is the boot-time entry point.

import type { EmailAdapter } from "../../channels/email.js";
import type { DrizzleDb } from "../../db/index.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../../db/repositories/settings.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { LinkedInSyncSink } from "../../channels/linkedin-sync.js";
import type { WhatsAppSyncSink } from "../../channels/whatsapp-sync.js";
import type { InboundDedup } from "../../channels/inbound-dedup.js";
import type { MailProvider } from "../../lib/rome-cloud-mail.js";
import { OAUTH_PROVIDERS } from "../../lib/oauth-providers.js";
import {
  createRomeCloudOAuthStartRedirect,
  redeemRomeCloudOAuthHandoff,
} from "../../lib/rome-cloud-oauth.js";
import { credentialFromBundle, grantProfileFromBundle } from "../providers-import.js";
import type { ConnectionRegistry } from "../registry.js";
import type { ConversationSettingsService } from "../../conversation-settings/service.js";
import type { ChatStopHandler } from "@rome-os/app-runtime";
import { makeDiscordDescriptor } from "./discord.js";
import { makeEmailDescriptor } from "./email.js";
import { createFeishuDescriptor } from "./feishu.js";
import { createLinkedInDescriptor } from "./linkedin.js";
import { makeTelegramDescriptor } from "./telegram.js";
import { makeTelegramUserDescriptor } from "./telegram-user.js";
import { makeOAuthProviderDescriptor } from "./oauth-providers.js";
import { createWechatDescriptor } from "./wechat.js";
import { makeWebchatDescriptor } from "./webchat.js";
import { createWhatsAppDescriptor } from "./whatsapp.js";

export { makeTelegramDescriptor, isTelegramAuthError } from "./telegram.js";
export { makeDiscordDescriptor, isDiscordAuthError } from "./discord.js";
export { makeTelegramUserDescriptor } from "./telegram-user.js";
export { createWechatDescriptor } from "./wechat.js";
export { createFeishuDescriptor } from "./feishu.js";
export { makeEmailDescriptor } from "./email.js";
export { makeWebchatDescriptor } from "./webchat.js";
export { createWhatsAppDescriptor } from "./whatsapp.js";
export { createLinkedInDescriptor } from "./linkedin.js";
export { makeOAuthProviderDescriptor, OAUTH_PROVIDER_GRANTS } from "./oauth-providers.js";

/**
 * The runtime dependencies the descriptor factories need, threaded from index.ts
 * where the repos/adapters exist (the registry itself is repo-free). Each field
 * mirrors exactly what the pre-cutover `new XAdapter(...)` construction passed.
 */
export interface BuiltinConnectionDeps {
  settingsRepo: SettingsRepository;
  conversationSettings: ConversationSettingsService;
  chatStop: ChatStopHandler;
  personMappingRepo: PersonMappingRepository;
  webchatRepo: WebChatRepository;
  whatsAppSyncSink: WhatsAppSyncSink;
  /** The LinkedIn inbox mirror (linkedin_threads/linkedin_messages). */
  linkedInSyncSink: LinkedInSyncSink;
  /** Jitter bounds for the LinkedIn poll cadence (config `linkedinPoll*Minutes`). */
  linkedinPoll: { minIntervalMs: number; maxIntervalMs: number };
  /** Loaded-agent lister (Discord/Feishu agent-binding validation + autocomplete). */
  listAgents: () => string[];
  /** Guardian auto-map on WhatsApp connect (canonical self JID → channel mapping). */
  onWhatsAppGuardianConnected: (selfJid: string) => void;
  /** Rome Cloud mail client for the Email adapter. */
  mailProvider: MailProvider;
  /** Optional email deps mirrored from index.ts (whoami resolver, dedup LRU). */
  emailOwnerEmailResolver?: () => Promise<string | undefined>;
  emailInboundDedup?: InboundDedup;
  /** Keeps index.ts's prompt-builder "our own inbox address" ref pointed at the
   *  CURRENT email epoch (birth/relock/backoff rebuild). */
  onEmailAdapterBuilt?: (adapter: EmailAdapter) => void;
  /** DB handle for the Rome Cloud-OAuth conferral setups (github/slack/google):
   *  the begin-redirect (mints the PKCE attempt) and the return-leg redeem both
   *  read/write the `oauth_pending_attempts` table. */
  db: DrizzleDb;
}

/**
 * Register every built-in connection descriptor on the registry. Boot-time only
 * (before `registry.load()`). The factories that need runtime deps get them from
 * `deps` (threaded from index.ts) — the registry stays repo-free.
 */
export function registerBuiltinConnections(
  registry: ConnectionRegistry,
  deps: BuiltinConnectionDeps,
): void {
  registry.register(makeTelegramDescriptor({ personMappingRepo: deps.personMappingRepo }));
  registry.register(
    makeDiscordDescriptor({
      conversationSettings: deps.conversationSettings,
      chatStop: deps.chatStop,
      personMappingRepo: deps.personMappingRepo,
      listAgents: deps.listAgents,
    }),
  );
  registry.register(makeTelegramUserDescriptor());
  registry.register(createWechatDescriptor());
  registry.register(
    createFeishuDescriptor({
      conversationSettings: deps.conversationSettings,
      personMappingRepo: deps.personMappingRepo,
      listAgents: deps.listAgents,
    }),
  );
  registry.register(
    makeEmailDescriptor({
      provider: deps.mailProvider,
      settingsRepo: deps.settingsRepo,
      personMappingRepo: deps.personMappingRepo,
      ownerEmailResolver: deps.emailOwnerEmailResolver,
      inboundDedup: deps.emailInboundDedup,
      onAdapterBuilt: deps.onEmailAdapterBuilt,
    }),
  );
  registry.register(makeWebchatDescriptor({ webchatRepo: deps.webchatRepo }));
  registry.register(
    createWhatsAppDescriptor({
      syncSink: deps.whatsAppSyncSink,
      onGuardianConnected: deps.onWhatsAppGuardianConnected,
    }),
  );
  registry.register(
    createLinkedInDescriptor({
      syncSink: deps.linkedInSyncSink,
      minIntervalMs: deps.linkedinPoll.minIntervalMs,
      maxIntervalMs: deps.linkedinPoll.maxIntervalMs,
    }),
  );
  // Rome Cloud-OAuth provider connection state (github/slack/
  // google; grant ledger only, no capabilities yet — Actors land in follow-ups).
  // The conferral setup drives connect through the generic setup
  // surface: begin-redirect → guardian consents on the broker → the return leg
  // resumes the coroutine → redeem → terminal confer (which re-materializes the
  // tmpfs token file + gh/git shell auth via custody). Registration is NOT gated
  // on the connect-UI provider list (google is env-gated there): state for an
  // existing providerAccounts row must import regardless. A `reconnect` hint is
  // always sent — every setup run is an explicit re-authorization, so it forces
  // fresh consent (correct for a degraded grant; a no-op-shaped extra on first
  // connect, where consent is shown anyway). This subsumes the legacy
  // reconnect route.
  for (const provider of OAUTH_PROVIDERS) {
    registry.register(
      makeOAuthProviderDescriptor(provider, {
        beginRedirect: () =>
          createRomeCloudOAuthStartRedirect(deps.db, provider, { reconnect: true }),
        redeem: async (handoff, state) => {
          const redeemed = await redeemRomeCloudOAuthHandoff(deps.db, handoff, state);
          const credential = credentialFromBundle(redeemed.provider, redeemed.tokens);
          if (!credential) {
            throw new Error("OAuth redemption produced no usable credential for the grant ledger.");
          }
          const profile = grantProfileFromBundle(
            redeemed.provider,
            redeemed.tokens,
            redeemed.profile ?? {},
          );
          // Omit an empty profile so the grant records no `{}` identity outcome
          // (parity with the redeem route's sparse-profile handling).
          return { credential, profile: Object.keys(profile).length > 0 ? profile : undefined };
        },
      }),
    );
  }
}
