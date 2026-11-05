// Stripe: the connected account's own events.

import {
  composioAdapter,
  fromComposio,
  identityOf,
  record,
  required,
  text,
} from "../../shared/composio.js";
import type { ComposioTriggerSpec, Watchable } from "../../types.js";
import { normalizeStripe } from "./normalize.js";

const stripe = (slug: string): ComposioTriggerSpec => ({ toolkit: "stripe", slug, config: {} });
export const STRIPE_CHARGE_FAILED = stripe("STRIPE_CHARGE_FAILED");
export const STRIPE_INVOICE_PAYMENT_FAILED = stripe("STRIPE_INVOICE_PAYMENT_FAILED");
export const STRIPE_DISPUTE_CREATED = stripe("STRIPE_CHARGE_DISPUTE_CREATED");
export const STRIPE_DISPUTE_CLOSED = stripe("STRIPE_CHARGE_DISPUTE_CLOSED");
export const STRIPE_CHARGE_REFUNDED = stripe("STRIPE_CHARGE_REFUNDED");
export const STRIPE_SUBSCRIPTION_DELETED = stripe("STRIPE_CUSTOMER_SUBSCRIPTION_DELETED");
export const STRIPE_PAYOUT_FAILED = stripe("STRIPE_PAYOUT_FAILED");
export const STRIPE_CHARGE_SUCCEEDED = stripe("STRIPE_CHARGE_SUCCEEDED");

export const STRIPE_WATCHABLE: Watchable = {
  source: "stripe",
  label: "Stripe",
  target: null,
  kinds: [
    {
      kind: "payment_failed",
      label: "Failed payments",
      default: true,
      triggers: [fromComposio(STRIPE_CHARGE_FAILED), fromComposio(STRIPE_INVOICE_PAYMENT_FAILED)],
    },
    {
      kind: "dispute",
      label: "Disputes",
      default: true,
      triggers: [fromComposio(STRIPE_DISPUTE_CREATED), fromComposio(STRIPE_DISPUTE_CLOSED)],
    },
    {
      kind: "refund",
      label: "Refunds",
      default: true,
      triggers: [fromComposio(STRIPE_CHARGE_REFUNDED)],
    },
    {
      kind: "subscription_canceled",
      label: "Canceled subscriptions",
      default: true,
      triggers: [fromComposio(STRIPE_SUBSCRIPTION_DELETED)],
    },
    {
      kind: "payout_failed",
      label: "Failed payouts",
      default: true,
      triggers: [fromComposio(STRIPE_PAYOUT_FAILED)],
    },
    {
      kind: "payment_succeeded",
      label: "Successful payments",
      default: false,
      triggers: [fromComposio(STRIPE_CHARGE_SUCCEEDED)],
    },
  ],
  options: [
    {
      key: "includeTestMode",
      label: "Include test-mode events",
      type: "boolean",
      default: false,
    },
  ],
};

export const stripeAdapter = composioAdapter({
  catalog: STRIPE_WATCHABLE,
  triggers: [
    STRIPE_CHARGE_FAILED,
    STRIPE_INVOICE_PAYMENT_FAILED,
    STRIPE_DISPUTE_CREATED,
    STRIPE_DISPUTE_CLOSED,
    STRIPE_CHARGE_REFUNDED,
    STRIPE_SUBSCRIPTION_DELETED,
    STRIPE_PAYOUT_FAILED,
    STRIPE_CHARGE_SUCCEEDED,
  ],
  // The connected Stripe account, by the name its dashboard shows.
  account: (env, service) =>
    identityOf(env, service, async () => {
      const account = await env.composio.read(service, {
        endpoint: "https://api.stripe.com/v1/account",
      });
      return required(
        service,
        text(record(record(account.settings).dashboard).display_name) ??
          text(record(account.business_profile).name) ??
          text(account.email) ??
          text(account.id),
      );
    }),
  normalize: (_env, { type, payload, account, kinds }) =>
    normalizeStripe(type, payload, { account, kinds }),
});
