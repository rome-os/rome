# People

Who is behind an account and how close they are to the guardian: people, their profiles, the links from accounts to people, and each person's timeline. The words it uses are defined in [`docs/domains/people.md`](../../../../docs/domains/people.md).

| Folder | Provides |
|---|---|
| root | Who is this: the person behind an account and their bond level, for the message path, apps and agents. |
| `model/` | Person, link, the account results, and the `PeopleRepository` port every feature changes people through. |
| `infrastructure/` | `DrizzlePeopleRepository`, which writes the people tables. The guardian profile still writes the guardian's person itself until ZHA-212. |
| `phone-book/` | The guardian's edits to people and accounts, and the account directory. Its use cases are in `application/`; the dashboard reaches them through `http/` and agents through `actions/` (`core:list_people`). Only the wiring imports it, so it can be left out. |
| `link-code/` | The code the guardian sends from an account to prove it is theirs. Its use case is in `application/`; the dashboard asks for a code through `http/`. |
| `guardian-profile/` | The guardian's name and background, and their agent's name. |
| `person-history/` | A person's messages across their accounts, and sending to them. Its use cases are in `application/`; the dashboard reaches them through `http/`. |

The import rules are in [`lint/rules/features.ts`](../../../../lint/rules/features.ts).
