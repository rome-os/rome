# People

Who is behind an account and how close they are to the guardian: people, their profiles, the links from accounts to people. The words it uses are defined in [`docs/domains/people.md`](../../../../docs/domains/people.md).

| Folder | Provides |
|---|---|
| root | Who is this: the person behind an account and their bond level, for the message path, apps and agents. |
| `model/` | Person, link, the account results, and the `PeopleRepository` port every feature changes people through. |
| `infrastructure/` | `DrizzlePeopleRepository`, which writes the people tables. |

The import rules are in [`lint/rules/features.ts`](../../../../lint/rules/features.ts).
