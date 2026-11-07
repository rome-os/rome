// A turn the provider refused, as the provider adapter sees it. The adapter
// tells its own account, and the account reports it from then on. Nothing
// outside the adapters' folder carries it.

export type RefusedTurn =
  /** The provider no longer accepts the credential. The adapter has persisted its marker. */
  | { kind: "credential" }
  /** The provider refused the turn for usage, until `until` when it said so. */
  | { kind: "usage"; until?: string };

export interface LearnsRefusedTurns {
  refusedTurn(refusal: RefusedTurn): void;
}
