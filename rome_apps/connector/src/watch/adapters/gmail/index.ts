// Gmail: new mail in the connected inbox, through Composio's polling trigger.

import { composioAdapter, identityOf, required, text } from "../../shared/composio.js";
import { KIND_OFF } from "../../shared/event.js";
import { MAIL_OPTIONS } from "../../shared/mail.js";
import type { ComposioTriggerSpec, Watchable } from "../../types.js";
import { normalizeGmail } from "./normalize.js";

export const GMAIL_TRIGGER_SLUG = "GMAIL_NEW_GMAIL_MESSAGE";
/** The event type the trigger publishes, as `eventSources` declares it. */
export const GMAIL_NEW_MAIL_TYPE = GMAIL_TRIGGER_SLUG.toLowerCase();
/** The trigger watches the inbox only; Composio wants the label as a string. */
export const GMAIL_TRIGGER_CONFIG = { labelIds: "INBOX" };

export const GMAIL_WATCHABLE: Watchable = {
  source: "gmail",
  label: "Gmail",
  target: null,
  kinds: [
    {
      kind: "new_mail",
      label: "New mail",
      default: true,
      // One Gmail account is connected at a time, so the event needs no filter.
      triggers: [{ provider: "gmail", type: GMAIL_NEW_MAIL_TYPE }],
    },
  ],
  options: MAIL_OPTIONS,
};

export const GMAIL_NEW_MAIL: ComposioTriggerSpec = {
  toolkit: "gmail",
  slug: GMAIL_TRIGGER_SLUG,
  config: GMAIL_TRIGGER_CONFIG,
};

export const gmailAdapter = composioAdapter({
  catalog: GMAIL_WATCHABLE,
  triggers: [GMAIL_NEW_MAIL],
  account: (env, service) =>
    identityOf(env, service, async () => {
      const data = await env.composio.read(service, {
        endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      });
      return required(service, text(data.emailAddress)?.toLowerCase());
    }),
  normalize: (_env, { payload, account, kinds }) =>
    kinds.has("new_mail")
      ? normalizeGmail(payload, { address: account })
      : { keep: false, reason: KIND_OFF },
});
