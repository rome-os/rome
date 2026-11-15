# Vault

The vault holds named secrets, such as an access token, that an agent can use for one command after the guardian approves. A value lives in the [signer](self-hosting.md) service and nowhere else: not in the database, not in a chat transcript, not in memory, and not in the environment of the agent's shell.

[App keys](concepts/apps.md) are a different store. An app key is read by apps and is visible to every agent shell. A vault secret reaches only the one command that asked for it.

## Use a secret

1. **Store it.** The guardian opens Settings, Advanced, Vault and adds the secret: a name, a value, and an optional note on what it is for. The name is an environment variable name: uppercase letters, digits and underscores, up to 64 characters. The page never shows a value again. To change one, retype it. A pasted `.env` adds several at once.
2. **Approve it.** The agent calls `vault_apply` with the name, a reason, and optionally a duration. The guardian sees "Use NAME for 15 min" with the reason on an approval card. Approving creates a grant. The agent finds names with `vault_search`, which returns descriptions and times, never values.
3. **Run with it.** The agent runs `vault load NAME -- command args...` in its shell. The command starts with the secret in its environment. `NAME,OTHER` loads several.

```sh
vault load GITHUB_TOKEN -- gh release create v1.2.0
```

`vault search [query]` lists the same metadata as `vault_search`. The CLI has no command that prints, exports or sets a value.

## Grants

- A grant covers one secret name for the whole instance, whichever agent or chat asks.
- The default length is 15 minutes and the longest is 3 hours. During the window `vault load` can run as often as it needs to.
- The window decides only whether `vault load` can still fetch the value. A command that started inside the window runs to the end, even after the grant expires.
- Grants live in the signer's memory. A signer restart ends them all. Deleting a secret ends its grant.
- Without a live grant, `vault load` fails and tells the agent to ask with `vault_apply`.

## Masking

`vault load` reads the command's stdout and stderr and replaces every exact copy of a loaded value with `[vault:NAME]`. It also catches a value split across two reads of the output. Masking is always on, and no option turns it off. It matches exact values only: an encoded or transformed copy, such as base64, prints as it is.

## Shared conversations

`vault load` refuses when the conversation is shared, because other people read the output. The agent tells the guardian to ask in a private chat. See [audience](domains/participation.md#audience).

## Instances without a signer

The vault needs the signer. An instance that runs without one shows an error in Settings, and `vault_apply`, `vault_search` and `vault load` report that the vault is not available. Secrets are not migrated from `.env` files or from other credential files. A rebuilt instance starts with an empty vault, because the store sits in the signer's key volume.

## Where it lives

| Part | Location |
| --- | --- |
| Store and grants | [`packages/signer/src/vault.ts`](../packages/signer/src/vault.ts), `secrets.json` in the signer's key directory (mode 0600) |
| Settings routes | [`packages/core/src/api/routes/vault.ts`](../packages/core/src/api/routes/vault.ts), `GET /api/vault`, `PUT` and `DELETE /api/vault/:name`, guardian only |
| Actions | `vault_search` and `vault_apply` in [`rome_apps/system/src/actions/`](../rome_apps/system/src/actions/) |
| CLI | [`packages/signer/src/vault-cli.ts`](../packages/signer/src/vault-cli.ts), linked as `vault` |
