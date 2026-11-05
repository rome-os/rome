import { describe, expect, it } from "@rstest/core";
import { STRIPE_WATCHABLE } from "./index.js";
import { amountOf, normalizeStripe } from "./normalize.js";

// Payloads as Composio's Stripe docs list them (`account`, `data.object`,
// `livemode`: docs.composio.dev/toolkits/stripe), with Stripe's own objects.
const ctx = { account: "Acme Inc", kinds: new Set(STRIPE_WATCHABLE.kinds.map((k) => k.kind)) };
const event = (object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  data: { object },
  livemode: true,
  ...extra,
});

describe("normalizeStripe", () => {
  it("gives a failed charge with its amount, customer, reason and dashboard link", () => {
    const result = normalizeStripe(
      "stripe_charge_failed",
      event({
        id: "ch_1",
        object: "charge",
        amount: 4900,
        currency: "usd",
        billing_details: { name: "Ana Lima", email: "ana@x.io" },
        failure_code: "card_declined",
        failure_message: "Your card was declined.",
      }),
      ctx,
    );
    expect(result).toEqual({
      keep: true,
      event: {
        id: "stripe:Acme Inc:ch_1:failed",
        source: "stripe",
        kind: "payment_failed",
        actor: "Ana Lima",
        subject: "Payment of 49.00 USD failed",
        url: "https://dashboard.stripe.com/payments/ch_1",
        excerpt: "Your card was declined.",
        byYou: false,
        addressedTo: "direct",
        labels: ["charge", "payment-failed", "card-declined"],
      },
    });
  });

  it("keeps each invoice attempt apart, and marks a retry of a subscription", () => {
    const invoice = (attempt: number) =>
      normalizeStripe(
        "stripe_invoice_payment_failed",
        event({
          id: "in_1",
          object: "invoice",
          amount_due: 1200,
          currency: "eur",
          customer_email: "bo@y.io",
          attempt_count: attempt,
          subscription: "sub_1",
        }),
        ctx,
      );
    const first = invoice(1);
    const second = invoice(2);
    expect(first.keep && second.keep && first.event.id !== second.event.id).toBe(true);
    expect(second).toMatchObject({
      keep: true,
      event: {
        subject: "Invoice payment of 12.00 EUR failed",
        url: "https://dashboard.stripe.com/invoices/in_1",
        labels: ["invoice", "payment-failed", "subscription", "retry"],
      },
    });
  });

  it("gives a dispute opened and closed, with its outcome", () => {
    const dispute = (status: string) => ({
      id: "dp_1",
      object: "dispute",
      amount: 15000,
      currency: "jpy",
      reason: "product_not_received",
      status,
    });
    expect(
      normalizeStripe("stripe_charge_dispute_created", event(dispute("needs_response")), ctx),
    ).toMatchObject({
      keep: true,
      event: {
        subject: "A payment of 15000 JPY is disputed",
        excerpt: "Reason: product not received.",
        labels: ["dispute", "opened"],
      },
    });
    expect(
      normalizeStripe("stripe_charge_dispute_closed", event(dispute("lost")), ctx),
    ).toMatchObject({
      keep: true,
      event: {
        subject: "A dispute over 15000 JPY closed: lost",
        labels: ["dispute", "closed", "lost"],
      },
    });
  });

  it("gives a partial refund, a canceled subscription and a failed payout", () => {
    expect(
      normalizeStripe(
        "stripe_charge_refunded",
        event({
          id: "ch_2",
          amount: 5000,
          amount_refunded: 2000,
          currency: "usd",
          refunded: false,
        }),
        ctx,
      ),
    ).toMatchObject({
      keep: true,
      event: {
        id: "stripe:Acme Inc:ch_2:refunded:2000",
        subject: "20.00 USD refunded so far of 50.00 USD",
        labels: ["refund", "partial-refund"],
      },
    });
    expect(
      normalizeStripe(
        "stripe_customer_subscription_deleted",
        event({
          id: "sub_1",
          object: "subscription",
          customer: "cus_1",
          status: "canceled",
          cancellation_details: {
            reason: "cancellation_requested",
            feedback: "too_expensive",
            comment: null,
          },
          items: {
            data: [
              { price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } },
            ],
          },
        }),
        ctx,
      ),
    ).toMatchObject({
      keep: true,
      event: {
        actor: "cus_1",
        subject: "A subscription of 29.00 USD a month ended",
        excerpt: "Feedback: too expensive.",
        labels: ["subscription", "canceled", "cancellation-requested"],
      },
    });
    const payout = normalizeStripe(
      "stripe_payout_failed",
      event({
        id: "po_1",
        amount: 100000,
        currency: "usd",
        failure_code: "account_closed",
        failure_message: "The bank account has been closed.",
      }),
      ctx,
    );
    expect(payout).toMatchObject({
      keep: true,
      event: {
        subject: "A payout of 1000.00 USD failed",
        labels: ["payout", "payout-failed", "account-closed"],
      },
    });
    expect(payout.keep && payout.event.actor).toBeUndefined();
  });

  it("marks test mode and connected accounts, and links to the test dashboard", () => {
    const result = normalizeStripe(
      "stripe_charge_succeeded",
      event({ id: "ch_3", amount: 100, currency: "usd" }, { livemode: false, account: "acct_9" }),
      ctx,
    );
    expect(result).toMatchObject({
      keep: true,
      event: {
        url: "https://dashboard.stripe.com/test/payments/ch_3",
        labels: ["charge", "payment-succeeded", "test-mode", "connected-account"],
      },
    });
  });

  it("drops a kind the follow has off, an object with no id, and an undeclared event", () => {
    const off = { account: "Acme Inc", kinds: new Set(["payment_failed"]) };
    expect(normalizeStripe("stripe_charge_succeeded", event({ id: "ch_3" }), off)).toEqual({
      keep: false,
      reason: "not a kind this follow has on",
    });
    expect(normalizeStripe("stripe_charge_failed", event({}), ctx)).toEqual({
      keep: false,
      reason: "no Stripe object id",
    });
    expect(normalizeStripe("stripe_price_created", event({ id: "price_1" }), ctx).keep).toBe(false);
  });
});

describe("amountOf", () => {
  it("counts hundredths, except in currencies counted in whole units", () => {
    expect(amountOf(4900, "usd")).toBe("49.00 USD");
    expect(amountOf(500, "JPY")).toBe("500 JPY");
    expect(amountOf(12345, "kwd")).toBe("12.345 KWD");
    for (const code of ["bhd", "jod", "omr", "tnd"]) {
      expect(amountOf(1000, code)).toBe(`1.000 ${code.toUpperCase()}`);
    }
    // Stripe counts UGX in hundredths.
    expect(amountOf(500000, "ugx")).toBe("5000.00 UGX");
    expect(amountOf(undefined, "usd")).toBeUndefined();
  });
});

describe("normalizeStripe, a canceled subscription's amount", () => {
  const ended = (subscription: Record<string, unknown>) =>
    normalizeStripe(
      "stripe_customer_subscription_deleted",
      event({ id: "sub_2", object: "subscription", customer: "cus_2", ...subscription }),
      ctx,
    );
  const item = (extra: Record<string, unknown> = {}, recurring: Record<string, unknown> = {}) => ({
    price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month", ...recurring } },
    ...extra,
  });

  it("gives the amount of one unit of one price billed every interval", () => {
    const one = ended({ items: { data: [item({ quantity: 1 })] } });
    expect(one.keep && one.event.subject).toBe("A subscription of 29.00 USD a month ended");
  });

  it("leaves the amount out for several units, items or intervals, or a metered price", () => {
    for (const items of [
      [item({ quantity: 3 })],
      [item(), item()],
      [item({}, { interval_count: 3 })],
      [item({}, { usage_type: "metered" })],
    ]) {
      const result = ended({ items: { data: items } });
      expect(result.keep && result.event.subject).toBe("A subscription ended");
    }
  });
});

describe("normalizeStripe, refunds in a row", () => {
  // A 50.00 charge refunded 20.00 and then 10.00: `amount_refunded` is the total so far.
  const charge = (total: number, refunds?: number[]) =>
    event({
      id: "ch_9",
      amount: 5000,
      amount_refunded: total,
      currency: "usd",
      refunded: false,
      ...(refunds
        ? {
            refunds: {
              data: refunds.map((amount, i) => ({ id: `re_${i}`, amount, currency: "usd" })),
            },
          }
        : {}),
    });
  const subjectOf = (payload: Record<string, unknown>) => {
    const result = normalizeStripe("stripe_charge_refunded", payload, ctx);
    return result.keep ? result.event.subject : undefined;
  };

  it("gives each refund's own amount when the charge lists its refunds, newest first", () => {
    expect(subjectOf(charge(2000, [2000]))).toBe("Refunded 20.00 USD");
    expect(subjectOf(charge(3000, [1000, 2000]))).toBe("Refunded 10.00 USD");
  });

  it("words the total as a total when the charge lists no refunds", () => {
    expect(subjectOf(charge(2000))).toBe("20.00 USD refunded so far of 50.00 USD");
    expect(subjectOf(charge(3000))).toBe("30.00 USD refunded so far of 50.00 USD");
  });

  it("keeps the two refunds apart", () => {
    const idOf = (payload: Record<string, unknown>) => {
      const result = normalizeStripe("stripe_charge_refunded", payload, ctx);
      return result.keep ? result.event.id : undefined;
    };
    expect(idOf(charge(2000))).not.toBe(idOf(charge(3000)));
  });
});
