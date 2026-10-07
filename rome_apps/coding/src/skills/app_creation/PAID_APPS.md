# Public Apps: Per-Visitor Data, Quotas, and Favor Payments

Companion to [`REFERENCE.md` → APIs](./REFERENCE.md#apis-createapihandlerctx). Read this when a shared or public app needs any of the following: Rome Cloud sign-in, data that each visitor owns privately, free allowances, or charges in favors. Each rule below came from shipping such an app. Following them avoids the usual leaks and double-credits.

## 1. Identity and ownership

- Take identity only from `request.caller`. A visitor's owner key is `caller.accountId`; the guardian maps to one fixed owner. Never accept an owner or account id from the browser.
- `requireVisitor(request)` gates signed-in routes. Return `visitorAuthRequired()` for every 401 so the frontend handles them the same way. In the UI, use `SignInWithRomeCloud` and `CallerBadge` from `@rome-os/app-web-sdk`.
- Put a non-null `owner` column on every root record. Child records (photos, results, media) inherit access through that root.
- Scope every list query by owner and every fetch-by-id by owner. A record owned by someone else returns **404**, not 403. Apply the same rule to nested resources, downloads, media routes, and job status. Background workers carry the originating owner and never bypass the check.
- Decide explicitly who owns legacy rows when you add the column. The usual answer is the guardian.

## 2. Free allowances and quotas

- Name the unit precisely before writing code: uploaded images, distinct normalized handles, generated films. Different units get separate counters.
- Reserve at the server boundary, before any expensive work starts. Do it atomically (a unique constraint or a conditional update in one transaction), so concurrent requests can't exceed the cap. A request-local counter or a limit enforced only in the frontend does not protect anything.
- Release the reservation exactly once if the work fails in a way the policy refunds. Make the release retry-safe so worker retries can't mint credits.
- The guardian bypasses caps. A fresh cache hit costs nothing.
- Work skipped for quota is stored as `unchecked`/`not attempted`. Never show it as a negative result.
- Show remaining allowance in the UI ("2 of 5 left"). Refresh it after uploads, refunds, and purchases.

## 3. Charging favors

The price is declared on an **action**, not chosen per request. Rome Cloud asks the visitor to consent, collects the favors, and then runs the action.

```yaml
# src/actions/buy-pack-30/action.yaml
name: buy_pack_30
type: custom
visibility: explicit          # hides it from wildcard discovery only; not a payment guard
description: >-
  Settle a 30-credit pack after a visitor pays. Idempotent per purchase.
entry: ./index.ts
complexity: simple
speed: fast
reliability: high
sideEffects: write
favorRequirement:
  amount: 99
  title: My App — 30 credits
  summary: Added to your account right after payment.
  displayFields:
    - label: Pack
      from: $.pack            # JSONPath into the action args; a bare key is rejected
```

- The `Action` returned by `createAction()` must include an `inputSchema` that covers every arg the API sends (`purchaseId`, `pack`). See [`REFERENCE.md` → Actions](./REFERENCE.md#actions-createactionconfig-deps). A separate `export const inputSchema` is not read. Without the schema the price never registers with Rome Cloud (the sync error is only logged), and checkout fails.
- **One action per price.** Use a separate action for each tier or promotional price. Never let the browser send a price or a quantity. Keep the pack definitions on the server.
- **Create the purchase row first.** The API handler stores `{ id, owner, pack, status: "awaiting_payment" }`, then calls:

  ```ts
  const favor = await ctx.favors.requestAction({
    actionName: "my-app:buy_pack_30",
    args: { purchaseId, pack: "30 credits" },
    taskRef: { purchaseId },
    idempotencyKey: `my-app-purchase:${purchaseId}`, // stable: a re-send never charges twice
    returnTo: `/apps/my-app/account?purchase=${purchaseId}`,
  });
  ```

- **Handle every status.** Store the request id on every status that returns one (`requestId`, or `request.id` for `queued`).
  - `pending_consent`: send the visitor to `authorizationUrl`. It is optional in the type, so treat a missing one as a retryable error.
  - `queued`: credit the purchase only if `request.status === "settled"`.
  - `declined`: mark the purchase declined.
  - `error` with `visitor_auth_required` or `visitor_favor_auth_required`: return `visitorAuthRequired()`. Any other error leaves the purchase uncredited and retryable.
- **The paid action settles only favor-dispatched runs.** `visibility: explicit` does not stop exact-name agent allowlists, routines, or `ctx.runAction` from running it, and those paths don't charge. Nested runs inherit `sharedContext`, so also require the id to match the current execution. If the check fails, return an error and change nothing:

  ```ts
  const run = getCurrentActionContext();
  const favorId = run?.sharedContext?.favorActionRequestId;
  if (typeof favorId !== "string" || run?.executionId !== favorId) {
    return { status: "error", error: "not_a_favor_dispatch" };
  }
  ```

  Then settle only the purchase `args.purchaseId` that is still `awaiting_payment`, whose pack is this action's own tier, and whose stored request id is unset or equal to it; the dispatcher can run before the API handler stores the id. Grant the amount the action defines, never one read from args. If the sync route already settled it under this same request id, return `{ status: "ok" }` and change nothing. An error result marks a paid request as a failed dispatch.
- **Settle idempotently from both sides.** The paid action settles with a conditional update. A `POST /purchases/:id/sync` route that the return page calls re-sends the *same* `requestAction` (same idempotency key) and settles if it finds the request settled. Whichever path runs first grants the credit, and the other does nothing. A return URL alone never grants credit.
- After settlement, resume any work that was skipped for quota. Don't just change the number shown in the UI.
- Owner previews of the paid UI must not create orders or charge anyone.

### Promo prices

Add a cheaper action, such as `buy_pack_promo`. The server validates the code (normalized, never shipped in the bundle) and creates a promo order. The cheap action settles **only** pre-authorized promo orders. Rome Cloud collects favors before the action runs, so reserve a one-time code atomically against the order *before* `requestAction`. Release it only when that request is declined or expired. Then two concurrent checkouts can't both pay for one code.

## 4. Verify before shipping

1. Signed-out requests to every data, mutation, and media route fail.
2. Account A cannot list or open account B's root or nested records, including by direct URL.
3. Concurrent requests over the cap: exactly the allowed number succeed. Refunds happen once.
4. A duplicate sync or a repeated settle grants credit once. Unpaid and declined returns, and runs of the paid action without `favorActionRequestId`, grant nothing.
5. The guardian is uncapped, and legacy rows have the intended owner.

Mocked visitor states are good for screenshot review, but they prove only the presentation. Report real checkout settlement as unverified until an authorized purchase exercises it. Never make a real payment the guardian didn't ask for.
