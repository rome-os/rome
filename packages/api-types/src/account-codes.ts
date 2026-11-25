// What `POST /api/account-codes` answers. Vocabulary:
// docs/domains/identity.md#account-code.

/** A code just given to the signed-in person. It is shown this once. */
export interface AccountCodeIssued {
  code: string;
  /** ISO 8601. After it the code adds nothing. */
  expiresAt: string;
  /** How long the code lasts from when it was given. Count down from this, not
   *  `expiresAt`, so a browser clock that is wrong does not change it. */
  expiresInSeconds: number;
}

/** The 403 body when the signed-in session belongs to no person. Other 403s
 *  carry no `code`. */
export interface AccountCodeNoPerson {
  error: string;
  code: "no_person";
}
