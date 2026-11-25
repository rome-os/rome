# Identity

Which person is behind an account. Every other part asks Identity and works with the person it answers, never with an account alone. In code, the `Identity` class in [`packages/core/src/identity/identity.ts`](../../packages/core/src/identity/identity.ts) answers it, with the types `Person` and `Account`.

## Person

Someone Rome knows, with a name and an avatar when Rome has them. A person is not an account: one person can have accounts on many platforms.

- Two persons are the same person when they are the same entry. Nothing on a platform makes two persons one.
- Deleting a person deletes every account of theirs, and each then belongs to nobody.
- Identity does not know who has a role. Access does.

## Account

A person's identity on a platform: the platform plus the platform's own id. The platforms are:

- `rome-cloud-email`: the email Rome Cloud reports for a sign-in. Rome trusts Rome Cloud to have verified it. Rome Cloud's own account id is no account.
- A connection's platform, such as Slack, with the sender id the connection reports on a message, so a Slack account names its workspace.
- `email`: the sender address of a message an email connection hears. Anyone can write any address there, so it proves nothing about a Rome Cloud sign-in, and the same address on `rome-cloud-email` is another account.

The rules of accounts:

- The same id on two platforms is two accounts.
- An account on `email` or `rome-cloud-email` is the address trimmed and lowercased, so one address is one account however it was typed.
- A Rome Cloud sign-in has its own platform so that a `rome-cloud` platform keyed by Rome Cloud's stable account id can be added beside it later, and so that an address heard through an email connection never counts as a sign-in.
- An account nobody holds belongs to nobody. That is an answer, not an error.

## One person per account

An account belongs to at most one person.

- Giving a person an account that belongs to another person is refused, and nothing changes. Giving it to the person who holds it changes nothing.
- A person made with an account that belongs to someone is not made at all.
- An account is free again once the person who held it is deleted or the account is removed from them.

## Claim

How an account nobody holds becomes a person's. Rome starts a claim on the account and sends its sign-in link to whoever uses the account. A person who opens the link while signed in and confirms it gets the account. In code, the steps are in [`packages/core/src/identity/application/account-claims.ts`](../../packages/core/src/identity/application/account-claims.ts).

- A claim is only for an account nobody holds. Starting one on an account a person holds is refused, and nothing changes.
- An account has at most one claim. Starting another replaces the earlier one, whose link then leads nowhere.
- A claim can be confirmed for 15 minutes after it starts, and once.
- Opening the link changes nothing. Only confirming writes.
- Confirming gives the account to the person and uses the claim up, together. When another person took the account since the claim started, it is refused, and nothing changes. Confirming for the person who already holds the account uses the claim up and changes nothing else.
- The link carries a random token. Rome stores only its hash, so the stored claim cannot be turned back into a link.
- The person who confirms is the one the sign-in is. Identity asks nothing more of them than that the person exists.

## Decided against

- **Identity inside People.** People grades how close someone is to the guardian. Who a person is and which accounts are theirs is asked by parts that grade nothing, such as Access deciding who is a member.
- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
- **The Rome Cloud id as the account.** It needed a step where an invited email is claimed by the Rome Cloud account that signs in with it, and an exception for the guardian. The costs accepted instead: an address that passes to someone else carries its access until that person is removed, and a member who changes their Rome Cloud email must be invited again (Ouou, 2026-11-25).
