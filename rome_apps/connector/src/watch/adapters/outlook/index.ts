// Outlook: new mail in the inbox. The trigger may carry only the message id,
// so its normalizer reads the message itself.

import {
  composioAdapter,
  fromComposio,
  identityOf,
  required,
  text,
} from "../../shared/composio.js";
import { MAIL_OPTIONS } from "../../shared/mail.js";
import type { ComposioTriggerSpec, Watchable } from "../../types.js";
import { normalizeOutlook } from "./normalize.js";
import { outlookReads } from "./reads.js";

export const OUTLOOK_NEW_MAIL: ComposioTriggerSpec = {
  toolkit: "outlook",
  slug: "OUTLOOK_MESSAGE_TRIGGER",
  config: {},
  unscoped: [
    "folder_id",
    "from_email",
    "to_email",
    "subject_contains",
    "has_attachments",
    "importance",
  ],
};

export const OUTLOOK_WATCHABLE: Watchable = {
  source: "outlook",
  label: "Outlook",
  target: null,
  kinds: [
    {
      kind: "new_mail",
      label: "New mail",
      default: true,
      triggers: [fromComposio(OUTLOOK_NEW_MAIL)],
    },
  ],
  options: MAIL_OPTIONS,
};

export const outlookAdapter = composioAdapter({
  catalog: OUTLOOK_WATCHABLE,
  triggers: [OUTLOOK_NEW_MAIL],
  account: (env, service) =>
    identityOf(env, service, async () => {
      const data = await env.composio.read(service, {
        endpoint: "https://graph.microsoft.com/v1.0/me",
      });
      return required(service, (text(data.mail) ?? text(data.userPrincipalName))?.toLowerCase());
    }),
  normalize: (env, { payload, account, kinds, service }) =>
    normalizeOutlook(payload, {
      address: account,
      kinds,
      reads: outlookReads(env, service),
    }),
});
