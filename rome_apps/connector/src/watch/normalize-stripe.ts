// Stripe's webhooks in the common shape. A payload is Stripe's event: the
// resource on `data.object`, `livemode`, and `account` when it came from a
// connected account. Every event concerns the guardian's own business, so
// it is addressed to them, and none is said to be by them.

import { drop, type Json, KIND_OFF, keep, type Normalized, obj, str } from "./normalize.js";

/** Currencies Stripe counts in whole units, not hundredths. */
const ZERO_DECIMAL = new Set(
  "bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "),
);

/** An amount in a currency's own units, such as `49.00 USD`. */
export function amountOf(amount: unknown, currency: unknown): string | undefined {
  if (typeof amount !== "number" || typeof currency !== "string") return undefined;
  const code = currency.toLowerCase();
  const value = ZERO_DECIMAL.has(code) ? String(amount) : (amount / 100).toFixed(2);
  return `${value} ${code.toUpperCase()}`;
}

const KINDS: Record<string, string> = {
  stripe_charge_failed: "payment_failed",
  stripe_invoice_payment_failed: "payment_failed",
  stripe_charge_dispute_created: "dispute",
  stripe_charge_dispute_closed: "dispute",
  stripe_charge_refunded: "refund",
  stripe_customer_subscription_deleted: "subscription_canceled",
  stripe_payout_failed: "payout_failed",
  stripe_charge_succeeded: "payment_succeeded",
};

const word = (value: string | undefined) =>
  value && /^[a-z0-9_]+$/.test(value) ? value.replaceAll("_", "-") : undefined;

/** A raw Stripe event of `type` in the common shape, or why it is not one. */
export function normalizeStripe(
  type: string,
  payload: Json,
  ctx: { account: string; kinds: ReadonlySet<string> },
): Normalized {
  const kind = KINDS[type];
  if (!kind) return drop(`Stripe ${type} is not a kind follows describe`);
  if (!ctx.kinds.has(kind)) return drop(KIND_OFF);
  const object = obj(obj(payload.data).object);
  const id = str(object.id);
  if (!id) return drop("no Stripe object id");
  const test = payload.livemode === false || object.livemode === false;
  const dashboard = `https://dashboard.stripe.com/${test ? "test/" : ""}`;
  const facts = [test && "test-mode", str(payload.account) && "connected-account"];
  const customer =
    str(obj(object.billing_details).name) ??
    str(object.customer_name) ??
    str(obj(object.billing_details).email) ??
    str(object.receipt_email) ??
    str(object.customer_email) ??
    str(object.customer);
  const base = { actor: customer, byYou: false, addressedTo: "direct" as const };
  const prefix = `${ctx.account}:${id}`;

  switch (type) {
    case "stripe_charge_failed":
    case "stripe_charge_succeeded": {
      const amount = amountOf(object.amount, object.currency);
      const failed = type === "stripe_charge_failed";
      return keep("stripe", `${prefix}:${failed ? "failed" : "succeeded"}`, kind, {
        ...base,
        subject: `Payment of ${amount ?? "an unknown amount"} ${failed ? "failed" : "succeeded"}`,
        url: `${dashboard}payments/${id}`,
        text: failed
          ? (str(object.failure_message) ?? str(obj(object.outcome).seller_message))
          : str(object.description),
        labels: [
          "charge",
          failed ? "payment-failed" : "payment-succeeded",
          failed && word(str(object.failure_code)),
          ...facts,
        ],
      });
    }
    case "stripe_invoice_payment_failed": {
      const amount = amountOf(object.amount_due, object.currency);
      const attempt = typeof object.attempt_count === "number" ? object.attempt_count : undefined;
      return keep("stripe", `${prefix}:failed:${attempt ?? ""}`, kind, {
        ...base,
        subject: `Invoice payment of ${amount ?? "an unknown amount"} failed`,
        url: `${dashboard}invoices/${id}`,
        text: attempt !== undefined ? `Attempt ${attempt}.` : undefined,
        labels: [
          "invoice",
          "payment-failed",
          str(object.subscription) && "subscription",
          attempt !== undefined && attempt > 1 && "retry",
          ...facts,
        ],
      });
    }
    case "stripe_charge_dispute_created":
    case "stripe_charge_dispute_closed": {
      const amount = amountOf(object.amount, object.currency);
      const status = word(str(object.status));
      const opened = type === "stripe_charge_dispute_created";
      return keep("stripe", `${prefix}:${opened ? "opened" : `closed:${status ?? ""}`}`, kind, {
        ...base,
        subject: opened
          ? `A payment of ${amount ?? "an unknown amount"} is disputed`
          : `A dispute over ${amount ?? "an unknown amount"} closed${status ? `: ${status}` : ""}`,
        url: `${dashboard}disputes/${id}`,
        text: str(object.reason)
          ? `Reason: ${str(object.reason)?.replaceAll("_", " ")}.`
          : undefined,
        labels: ["dispute", opened ? "opened" : "closed", !opened && status, ...facts],
      });
    }
    case "stripe_charge_refunded": {
      const refunded = amountOf(object.amount_refunded, object.currency);
      const full = object.refunded === true;
      return keep("stripe", `${prefix}:refunded:${str(object.amount_refunded) ?? ""}`, kind, {
        ...base,
        subject: `Refunded ${refunded ?? "an unknown amount"}`,
        url: `${dashboard}payments/${id}`,
        text: str(object.description),
        labels: ["refund", full ? "full-refund" : "partial-refund", ...facts],
      });
    }
    case "stripe_customer_subscription_deleted": {
      const item = obj(
        (Array.isArray(obj(object.items).data) ? (obj(object.items).data as unknown[]) : [])[0],
      );
      const price = obj(item.price);
      const amount = amountOf(price.unit_amount, price.currency);
      const every = str(obj(price.recurring).interval);
      const why = obj(object.cancellation_details);
      return keep("stripe", `${prefix}:canceled`, kind, {
        ...base,
        subject: `A subscription${amount ? ` of ${amount}${every ? ` a ${every}` : ""}` : ""} ended`,
        url: `${dashboard}subscriptions/${id}`,
        text:
          str(why.comment) ??
          (str(why.feedback) ? `Feedback: ${str(why.feedback)?.replaceAll("_", " ")}.` : undefined),
        labels: ["subscription", "canceled", word(str(why.reason)), ...facts],
      });
    }
    case "stripe_payout_failed": {
      const amount = amountOf(object.amount, object.currency);
      return keep("stripe", `${prefix}:failed`, kind, {
        ...base,
        actor: undefined,
        subject: `A payout of ${amount ?? "an unknown amount"} failed`,
        url: `${dashboard}payouts/${id}`,
        text: str(object.failure_message),
        labels: ["payout", "payout-failed", word(str(object.failure_code)), ...facts],
      });
    }
    default:
      return drop(`Stripe ${type} is not a kind follows describe`);
  }
}
