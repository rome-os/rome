// What `POST /api/account-codes` answers. Vocabulary:
// docs/domains/identity.md#account-code.

/** A code just given to the signed-in person. It is shown this once. */
export interface AccountCodeIssued {
  code: string;
  /** ISO 8601. After it the code adds nothing. */
  expiresAt: string;
}
