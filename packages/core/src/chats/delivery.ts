// How an outbound message stands with its platform. Vocabulary:
// docs/domains/chats.md#delivery.

/** A message's delivery. `error` is the platform's own words when it refused,
 *  and is set only on a failed delivery. `at` is when the state was set. */
export type Delivery =
  | { readonly state: "pending"; readonly at: Date }
  | { readonly state: "sent"; readonly at: Date }
  | { readonly state: "failed"; readonly error: string; readonly at: Date };

export type DeliveryState = Delivery["state"];
