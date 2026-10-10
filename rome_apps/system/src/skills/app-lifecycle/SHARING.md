# Share an app through its URL

Every Rome instance already has a public address, such as `https://<name>.romeos.cc`. To let other people use an installed app, change the app's **access mode**. The app keeps running on this Rome. It does not need a separate host, domain, or deployment.

## Access modes

| Mode | Who can open the app |
|---|---|
| `private` (default) | Only the guardian. |
| `public` | Anyone with the URL, including anonymous visitors. Routes inside the app can still require Rome Cloud sign-in. |
| `cloud-email` | Only visitors who sign in with Rome Cloud using one of the listed emails. |

The access mode applies only to the public URL. The guardian's own dashboard access does not change. Only apps with a web UI can be shared. A workflow app that has no page cannot be shared.

The link to share is the standalone route `https://<public address>/full/apps/<appId>`. It opens the app without the dashboard around it.

## Before you share

The host checks the access mode before a request reaches the app. After that, every visitor reaches the same handlers as the guardian. Check these before a mode other than `private` goes on:

1. **Owner-only operations.** Gate settings writes, agent dispatch, and destructive routes on `request.caller.kind === "guardian"`. Never gate the whole handler. That blocks every visitor.
2. **Per-visitor data, quotas, and payment.** If visitors create their own records, use paid or expensive work (agent runs, image generation), or pay in favors, read `PAID_APPS.md` in the `coding:app_creation` skill directory and follow it.
3. **Cost and exposure.** Visitors run on the guardian's Rome, data, and model accounts. Tell the guardian what a visitor can trigger.

## Change the access mode

The guardian can do it: open **Apps**, select the app, select **Access**, choose the mode, and copy the link.

When the guardian asks you to do it for a specific app and mode, use the loopback API. The policy for all apps is one document, so read it, change only this app, and write the whole document back:

```bash
curl -s http://127.0.0.1:4141/api/public-access
# {"enableAccessControl":false,"allowedApps":[...],"cloudEmailAccess":{...}}
```

- `public`: add the app id to `allowedApps` and remove its `cloudEmailAccess` entry.
- `cloud-email`: set `cloudEmailAccess["<appId>"]` to the email list and remove the id from `allowedApps`.
- `private`: remove the app from both.

Keep `enableAccessControl` and every other app's entry unchanged. Then send the document:

```bash
curl -s -X PUT http://127.0.0.1:4141/api/public-access \
  -H 'content-type: application/json' -d @policy.json
```

Use only this endpoint. A write to `publicAccess` through `/api/settings` is rejected, and it would not reload the proxy. A `500` from this endpoint means the policy is saved but the proxy did not reload. Retry the same request.

## Verify

Test from outside, without the guardian's session, against the public address. The page shell loads for every app, so test the app's API, not the page:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<public address>/api/apps/<appId>/<any route>
```

A `private` app returns `401`. A `public` app reaches the handler (a missing route returns `404`). Owner-only routes must return `403` to a visitor.
