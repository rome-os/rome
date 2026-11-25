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

## Account code

How an account nobody holds becomes a person's. A signed-in guardian or member gets a code of their own. Sending that code to Rome in a direct message from an account adds the account to their person. In code, the steps are in [`packages/core/src/identity/application/account-codes.ts`](../../packages/core/src/identity/application/account-codes.ts).

- A code belongs to one person. A new code replaces the person's earlier one, and the earlier one then adds nothing.
- A code can be used for ten minutes after it is given, and once.
- Rome never stores the code, only a hash of it. The stored hash cannot be turned back into a code.
- The whole message must be the code. Case and surrounding spaces do not matter. A code inside a longer text is not a code.
- Sending the code adds the account and uses the code up, together. An account that belongs to another person is refused, nothing changes, and the code can still be used. An account the person already holds uses the code up and changes nothing else.
- A code adds an account on a platform a connection hears, never a sign-in address. Sending it from an email or Rome Cloud email account is refused.
- The code is sent in a direct message to an account Rome speaks as, a bot or an app. A code shown in a shared chat there is voided, even inside a longer text. A code sent to the guardian's own account is an ordinary message. Chats applies these rules when it [hears the message](chats.md#message), not Identity.
- Deleting a person deletes their open code.
- A code proves that whoever sent it had the code. A person who gives their code to someone else gives that account their role, so the page that shows a code tells the person to send it only from their own account and to share it with nobody (accepted cost, Ouou, 2026-11-25).

## Decided against

- **Identity inside People.** People grades how close someone is to the guardian. Who a person is and which accounts are theirs is asked by parts that grade nothing, such as Access deciding who is a member.
- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
- **A link that carries the secret.** It proved only that the person confirming held the link, and a link can be passed on.
- **The Rome Cloud id as the account.** It needed a step where an invited email is claimed by the Rome Cloud account that signs in with it, and an exception for the guardian. The costs accepted instead: an address that passes to someone else carries its access until that person is removed, and a member who changes their Rome Cloud email must be invited again (Ouou, 2026-11-25).
