# Identity

Which person is behind an account. Every other part asks Identity and works with the person it answers, never with an account alone. In code, the `Identity` class in [`packages/core/src/identity/identity.ts`](../../packages/core/src/identity/identity.ts) answers it, with the types `Person` and `Account`.

## Person

Someone Rome knows, with a name and an avatar when Rome has them. A person is not an account: one person can have accounts on many platforms.

- Two persons are the same person when they are the same entry. Nothing on a platform makes two persons one.
- Deleting a person deletes every account of theirs, and each then belongs to nobody.
- Identity does not know who has a role. Access does.

## Account

A person's identity on a platform: the platform plus the platform's own id. The platform is `email`, Rome Cloud, or a connection's platform such as Slack. The id is the sender id the connection reports on a message, so a Slack account names its workspace.

- The same id on two platforms is two accounts.
- An email account is the address trimmed and lowercased, so one address is one account however it was typed.
- An account nobody holds belongs to nobody. That is an answer, not an error.

## One person per account

An account belongs to at most one person.

- Giving a person an account that belongs to another person is refused, and nothing changes. Giving it to the person who holds it changes nothing.
- A person made with an account that belongs to someone is not made at all.
- An account is free again once the person who held it is deleted or the account is removed from them.

## Decided against

- **Identity inside People.** People grades how close someone is to the guardian. Who a person is and which accounts are theirs is asked by parts that grade nothing, such as Access deciding who is a member.
- **Roles in Identity.** Identity would then answer two questions, and every part that only asks who a sender is would depend on roles.
