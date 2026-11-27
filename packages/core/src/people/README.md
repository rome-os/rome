# People

Who is behind an account and how close they are to the guardian: people, their profiles, the links from accounts to people, and each person's timeline. The words it uses are defined in [`docs/domains/people.md`](../../../../docs/domains/people.md).

| Folder | Provides |
|---|---|
| root | Who is this: the person behind an account and their bond level, for the message path, apps and agents. |
| `model/` | Person, link, the account results, and the `PeopleRepository` port every feature changes people through. |
| `infrastructure/` | `DrizzlePeopleRepository`, which writes the people tables. |
| `phone-book/` | The people listing and the account directory. Its use cases are in `application/`; the dashboard reads them through `http/` (`GET /api/people`, `GET /api/accounts`) and agents through `actions/` (`core:list_people`). Only the wiring imports it, so it can be left out. |
| `person-history/` | A person's messages across their accounts, and sending to them. Its use cases are in `application/`; the people listing reads each account's last activity and send state through them, and the assistants' routes send through them. It has no routes of its own. |

The import rules are in [`lint/rules/features.ts`](../../../../lint/rules/features.ts).
