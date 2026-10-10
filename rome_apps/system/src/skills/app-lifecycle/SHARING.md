# Share an app through its URL

A hosted Rome instance already has a public address, such as `https://<name>.romeos.cc`. Your runtime context states it when one exists. To let other people use an installed app on such an instance, change the app's **access mode**. The app keeps running on this Rome. It does not need a separate host, domain, or deployment.

A desktop or local self-hosted Rome may have no public address. On those instances, changing the access mode does not make the app reachable from outside. Check for a public address before you offer anyone a URL. If there is none, tell the guardian.

## Access modes

| Mode | Who can open the app |
|---|---|
| `private` (default) | Only the guardian. |
| `public` | Anyone with the URL, including anonymous visitors. Routes inside the app can still require Rome Cloud sign-in. |
| `cloud-email` | Only visitors who sign in with Rome Cloud using one of the listed emails. |

The access mode applies only to the public URL. The guardian's own dashboard access does not change. Only apps with a web UI can be shared. A workflow app that has no page cannot be shared.

The link to share is the standalone route `https://<public address>/full/apps/<appId>`. It opens the app without the dashboard around it.

In every URL path, encode the app id as one segment with `encodeURIComponent(appId)`. A scoped id such as `@alice/notes` becomes `%40alice%2Fnotes`. JSON bodies, such as the access policy below, keep the plain id.

## Before you share

The host checks the access mode before a request reaches the app. After that, every visitor reaches the same handlers as the guardian. Check these before a mode other than `private` goes on:

1. **Owner-only operations.** Gate settings writes, agent dispatch, and destructive routes on `request.caller.kind === "guardian"`. Never gate the whole handler. That blocks every visitor.
2. **Per-visitor data, quotas, and payment.** If visitors create their own records, use paid or expensive work (agent runs, image generation), or pay in favors, read `PAID_APPS.md` in the `coding:app_creation` skill directory and follow it.
3. **Cost and exposure.** Visitors run on the guardian's Rome, data, and model accounts. Tell the guardian what a visitor can trigger.

## Change the access mode

The guardian can do it: open **Apps**, select the app, select **Access**, choose the mode, and copy the link.

When the guardian asks you to do it for a specific app and mode, use the loopback API. Its port is `INTERNAL_API_PORT`, 4141 by default. The policy for all apps is one document. Read it, change only this app, and write the whole document back. A `PUT` with an empty or invalid body resets every app to `private`, so run each step only when the one before it succeeded:

```bash
API="http://127.0.0.1:${INTERNAL_API_PORT:-4141}/api/public-access"
APP='<appId>'                 # the plain id, not URL-encoded
MODE=public                   # public | cloud-email | private
EMAILS='["a@example.com"]'    # used only by cloud-email

policy=$(curl -sf "$API") &&
updated=$(printf '%s' "$policy" | jq -ec --arg app "$APP" --arg mode "$MODE" --argjson emails "$EMAILS" '
  .allowedApps -= [$app] | del(.cloudEmailAccess[$app])
  | if $mode == "public" then .allowedApps += [$app]
    elif $mode == "cloud-email" then .cloudEmailAccess[$app] = $emails
    else . end') &&
printf '%s' "$updated" | curl -sf -X PUT "$API" -H 'content-type: application/json' --data-binary @-
```

The filter leaves `enableAccessControl` and every other app's entry unchanged. Afterwards, read the policy again. Confirm that this app's entry changed as intended and that the other entries match `$policy`. The server drops invalid app ids and emails without an error, so a missing entry means the input was invalid.

Use only this endpoint. A write to `publicAccess` through `/api/settings` is rejected, and it would not reload the proxy. A `500` from this endpoint means the policy is saved but the proxy did not reload. Retry the same request.

## Verify

Test from outside, without the guardian's session, against the public address. The page shell loads for every app, so test the app's API, not the page:

```bash
curl -s -w '\n%{http_code}\n' https://<public address>/api/apps/<encoded appId>/<any route>
```

- A `private` app is refused before it reaches the handler. Usually this is `401`. When `enableAccessControl` is on, the proxy returns `403` with `"error":"not_public"` instead.
- A `public` app reaches the handler. A missing route returns `404`.
- An owner-only route returns `403` to a visitor from the app's own handler. Its body is the app's error, not `not_public`.
