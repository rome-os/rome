# Publish an app to the Rome App Store

Publishing uploads one version of an installed app to the Rome App Store. Other people can then find it and install their own copy into their own Rome. This is different from sharing: a shared app runs on this Rome (see [`SHARING.md`](./SHARING.md)), but a published app runs on each installer's Rome.

There is no review queue. If the store accepts the upload, the version is live at once, for anyone. Versions are immutable. Publish only when the guardian asks to publish that app.

## Requirements

- **The app was developed on this Rome.** It was installed from its source workspace or from a local bundle. Apps installed from the Store and first-party apps cannot be published from here.
- **This Rome is connected to a Rome account.** The upload uses the instance's credential, and the listing belongs to that account.
- **The listing id is free or already yours.** The listing id is `id` in `app.yaml`. The first account that publishes an id owns it. Another account's id is refused with `403`.
- **The version is new.** `version` in `app.yaml` must be strict SemVer and higher than every version already in the listing.

## Prepare the listing

The listing copy lives beside the app's source. It is uploaded separately from the installable bundle:

- `.rome_store/rome_store.yaml`: `title`, `description`, `long_description`, `categories`, `keywords`, optional `image` and `media`, and `preview` / `noindex`.
- `README.md` at the app root: the body of the store page.

Write both as product copy for users: what the app does, its main features, and when to use it. Do not include file paths, schemas, or action names. Put screenshots and videos under `.rome_store/assets/` and reference them from `media`. The store shows at most 8 items. Images are PNG, JPEG, or WebP up to 2 MB. Videos are MP4, WebM, or MOV up to 25 MB. The whole `.rome_store` folder is limited to 30 MB. If the listing has no `image`, Rome generates a share card from the app's icon, name, and `tagline`.

`preview: on` adds a "try it" link to the store page. It works only for apps with a web UI. `includeSource: true` in `app.yaml` publishes `src/` with the bundle, so installers can remix the app.

## Publish

1. Bump `version` in `app.yaml` and commit.
2. Reinstall from source (`install` in [`SKILL.md`](./SKILL.md)). The publish ships the exact packed artifact that is installed. If the source changed after the last install, the publish is refused until you reinstall. Edits under `.rome_store/` alone do not need a reinstall.
3. Publish:
   - The guardian can open **Apps**, select the app, and select **Publish**.
   - When the guardian asked you to publish, call the loopback API:

     ```bash
     curl -s -X POST http://127.0.0.1:4141/api/apps/<appId>/publish
     ```

     A `201` returns the listing id and the published version. Errors come back with the store's message unchanged. Fix the cause and do not retry blindly: `409` means reinstall, `412` means this Rome is not connected to a Rome account, and `400` or `403` from the store usually means a version or ownership problem.
4. Verify with `system:app_store_search` that the listing shows the new version. Report the listing id and version to the guardian.

## Update or remove

To ship a change, repeat the publish steps with a higher version. Installers upgrade from their own dashboard. This skill has no way to withdraw a version. If the guardian wants a listing removed, tell them to manage it from their Rome Cloud account.
