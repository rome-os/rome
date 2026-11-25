// What the phone book needs from the rest of Rome, for its routes and its
// actions alike. The wiring fills it in.

import type { AccountDirectoryDeps } from "./application/account-directory.js";
import type { PeopleReadDeps } from "./application/resource.js";

export type PhoneBookDeps = PeopleReadDeps & AccountDirectoryDeps;
