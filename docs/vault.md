# Vault

The vault holds named secrets, such as an access token, that an agent can use for one command after the guardian approves. Rome stores a value in the [signer](self-hosting.md) service, not in the database, a chat transcript or memory, and does not put it in the environment of the agent's shell. The vault hands a value to a command only through `vault load`, after the guardian approves.

[App keys](concepts/apps.md) are a different store. An app key is read by apps and is visible to every agent shell. A vault secret goes only to the command `vault load` starts, and only while a grant is live.

## Use a secret

1. **Store it.** The guardian opens Settings, Advanced, Vault and adds the secret: a name, a value, and an optional note on what it is for. The name is an environment variable name: uppercase letters, digits and underscores, up to 64 characters. The page never shows a value again. To change one, retype it. A pasted `.env` adds several at once. Adding or replacing a secret asks for the [PIN](#pin) first, in a step before the form.
2. **Approve it.** The agent calls `vault_apply` with the names of one to 10 secrets, a reason, and optionally a duration. The guardian sees "Use NAME for 15 min" with the reason on one approval card, and the names listed together when there are several. Entering the PIN and choosing Allow creates the grant. The agent finds names with `vault_search`, which returns descriptions and times, never values.
3. **Run with it.** The agent runs `vault load NAME -- command args...` in its shell. The command starts with the secret in its environment. `NAME,OTHER` loads several, such as the names of one `vault_apply` request.

```sh
vault load GITHUB_TOKEN -- gh release create v1.2.0
```

`vault search [query]` lists the same metadata as `vault_search`. The CLI has no command that prints, exports or sets a value.

## Grants

- A grant covers one secret name for the whole instance, whichever agent or chat asks.
- A grant lasts for its whole time in every chat, wherever it was approved.
- A request that names several secrets gets one PIN check and one duration. The signer grants all of them or none, so one unknown name grants nothing.
- The default length is 15 minutes and the longest is 3 hours. During the window `vault load` can run as often as it needs to.
- The window decides only whether `vault load` can still fetch the value. A command that started inside the window runs to the end, even after the grant expires.
- Grants live in the signer's memory. A signer restart ends them all. Deleting a secret ends its grant.
- Without a live grant, `vault load` fails and tells the agent to ask with `vault_apply`.

## PIN

A 6-digit PIN guards every write of a secret value and every grant. The guardian types it in six boxes, and the signer checks it. The signer never stores the PIN itself, only a salted scrypt hash in `vault-pin.json` in its key directory (mode 0600).

- Settings asks for the PIN before the add and replace form. When no PIN exists, the step asks for a new one twice and sets it. Otherwise it asks for the PIN once.
- The step does not check the PIN. Rome holds it in memory and sends it with each save, and the signer checks it there. A refused PIN returns to the step and keeps what the guardian typed in the form.
- A pasted `.env` uses one PIN for the batch and stops at the first refused PIN.
- Every grant asks for the PIN on the approval card.
- Three wrong PINs in a row lock every PIN check for 15 minutes. The count and the lock sit on disk, so a signer restart does not clear them.
- While the vault is locked, the card and the Settings field show when to try again.
- A correct PIN resets the count.
- Deleting a secret needs no PIN.
- Without a PIN, the signer refuses every save and grant.

There is no way to change the PIN. If the guardian forgets it, Forgot PIN in Settings resets the vault. A reset deletes every secret and every grant, and sets a new PIN in the same step. It needs no old PIN and works while the vault is locked.

The browser sends the PIN to Rome, and Rome passes it to the signer in memory. Rome does not write it to the database, a log, the chat or the approval. Only a dashboard session can send it. The generic approve routes that other clients use, such as the iOS app, answer 422 for `vault_apply` and leave the approval pending.

`vault_apply` does not create the grant. The grant exists when the guardian approves with the PIN, and the action reports it. An approval that is not made with the PIN leaves no grant, and `vault_apply` tells the agent so. The agent never asks for the PIN in the chat.

## What the PIN does not cover

Someone with access to the signer's key volume on the host can read the secrets, because `secrets.json` stores values as they are. A 6-digit PIN hash is also quick to brute-force offline. A process that can read or change Rome's memory or files can capture the PIN when the guardian types it. The lock limits guesses through the signer's socket and does nothing against these.

## Masking

`vault load` reads the command's stdout and stderr and replaces every exact copy of a loaded value with `[vault:NAME]`. It also catches a value split across two reads of the output. Masking is always on, and no option turns it off. It matches exact values only: an encoded or transformed copy, such as base64, prints as it is.

## Instances without a signer

The vault needs the signer. An instance that runs without one shows an error in Settings, and `vault_apply`, `vault_search` and `vault load` report that the vault is not available. Secrets are not migrated from `.env` files or from other credential files. A rebuilt instance starts with an empty vault, because the store sits in the signer's key volume.

The vault also needs a signer that checks the PIN. Rome asks the signer for its health before every vault request. If the signer does not report `vault: 2`, the routes answer 503 with "The signer is too old for the vault". Rome forwards nothing to it, because an older signer ignores the PIN and grants anyway. Upgrade the instance to use the vault.

## Where it lives

| Part | Location |
| --- | --- |
| Store, grants and PIN | [`packages/signer/src/vault.ts`](../packages/signer/src/vault.ts), `secrets.json` and `vault-pin.json` in the signer's key directory (mode 0600) |
| Signer routes | `GET /v1/secrets`, `PUT` and `DELETE /v1/secrets/:name`, `POST /v1/grants`, `POST /v1/pin`, `POST /v1/reset`, `GET /v1/health` |
| Dashboard routes | [`packages/core/src/api/routes/vault.ts`](../packages/core/src/api/routes/vault.ts), the [team](concepts/people.md#team) only |
| Actions | `vault_search` and `vault_apply` in [`rome_apps/system/src/actions/`](../rome_apps/system/src/actions/) |
| CLI | [`packages/signer/src/vault-cli.ts`](../packages/signer/src/vault-cli.ts), linked as `vault` |

The dashboard routes under `/api/vault`:

| Route | Use | Needs the PIN |
| --- | --- | --- |
| `GET /api/vault` | List the secrets and the PIN state | No |
| `PUT /api/vault/:name` | Save a value | Yes, browser session only |
| `DELETE /api/vault/:name` | Remove a secret | No |
| `POST /api/vault/pin` | Set the first PIN | Browser session only |
| `POST /api/vault/reset` | Delete every secret and set a new PIN | No, the guardian's browser session only |
| `POST /api/vault/grants` | Grant a secret and approve its `vault_apply` request | Yes, browser session only |
