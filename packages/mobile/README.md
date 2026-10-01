# rome-mobile

Rome Mobile is a Native Launcher for Rome Cloud services. It uses the system authentication session for Cloud login, then opens only the selected Rome in a WebView.

The Native flow follows [RFC 065](../../docs/rfcs/065-native-mobile-cloud-login-and-instance-session.md). Browser login on Rome Core remains available for desktop clients.

## Credentials

The app uses three credentials:

- A Rome Cloud device credential lists services and creates instance authorizations.
- A short-lived authorization code carries one Cloud identity to one Rome Core.
- A `rome_session` authenticates Native API requests and the selected WebView.

The Cloud device credential and every `rome_session` live in SecureStore. iOS uses Keychain with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Android uses Keystore-backed storage. AsyncStorage holds only the selected service metadata.

`RomeApiClient` accepts only relative `/api/*` paths. It sends a session only to the selected HTTPS origin, blocks redirects, and refreshes once after a 401. `InstanceSessionCoordinator` merges concurrent refreshes for the same origin.

The app writes `rome_session` to `WKHTTPCookieStore` on iOS and `CookieManager` on Android before mounting the WebView. The first WebView request also carries the same cookie header. The app never injects the token with JavaScript.

## Login flow

1. The Launcher opens Rome Cloud with `ASWebAuthenticationSession` or an Android Custom Tab.
2. The app exchanges the PKCE-bound code for a Cloud device credential.
3. The app calls `GET /v1/instances` and shows the returned services.
4. The selected Core returns a Native authorization request.
5. Rome Cloud returns a single-use code for that exact service.
6. The selected Core exchanges the code and returns a `rome_session`.
7. The app verifies the session through `/api/auth/verify` before mounting the WebView.

Cloud 401 responses clear only the Cloud device credential. Instance 401 responses refresh the instance session once. A Cloud outage does not delete an unexpired instance session.

## Navigation

The selected Rome's WebView follows platform navigation:

- Android's back button steps back through the WebView history. With no earlier page, the press leaves the app.
- On iOS, swiping from the left edge goes back and swiping from the right edge goes forward.
- Pulling down from the top of the page reloads it. The gesture starts only when the touched pane and the page are both scrolled to the top, so pulling inside a scrolled chat transcript scrolls it instead. It does not start on text fields, while a dialog, sheet, popover, or menu is open, or inside an app's iframe.

The dashboard turns off root overscroll, so a native refresh control cannot be pulled. An injected page script detects the pull and reports it to the app, which draws the indicator and reloads.

## OAuth callbacks

Rome Cloud registers these production clients:

- `rome-mobile-ios` identifies iOS device sessions.
- `rome-mobile-android` identifies Android device sessions.

Both clients use `cc.romeos.mobile:/oauth/callback`. Expo registers this reverse-domain private URL scheme on iOS and Android. Mobile login does not require Associated Domains, an `apple-app-site-association` file, an Android App Link, or `assetlinks.json`. Development and production builds reuse the client for their platform and the same callback.

## Configuration

Set these values before a Native build:

```bash
export EXPO_PUBLIC_PANTHEON_ORIGIN="https://<rome-cloud-host>"
export EXPO_PUBLIC_APPLE_TEAM_ID="<apple-team-id>"
```

The app selects `rome-mobile-ios` or `rome-mobile-android` from the build platform. Both platforms use the fixed `cc.romeos.mobile:/oauth/callback` callback. `EXPO_PUBLIC_ROME_MOBILE_CLIENT_ID` can override the client for a controlled test build, but it must match the platform registered by Rome Cloud.
iOS requests an ephemeral authentication session, so Cloud login does not share Safari cookies or show the Safari data-sharing confirmation dialog.

If a Personal Team cannot sign APNs, use a Team-owned Bundle ID and remove push from the generated entitlements:

```bash
export EXPO_PUBLIC_IOS_BUNDLE_IDENTIFIER="cc.romeos.mobile1"
export EXPO_PUBLIC_ROME_PUSH_ENABLED="false"
```

Push-enabled iOS builds also require `EXPO_PUBLIC_APNS_ENVIRONMENT` set to `sandbox` or `production`. APNs-disabled builds do not request notification permission or register a token.

## Run

From the repository root:

```bash
pnpm install
pnpm --filter rome-mobile typecheck
pnpm --filter rome-mobile test
pnpm --dir packages/mobile exec expo run:ios --device <device-name>
```

The Widget and cookie store use Native modules. Expo Go cannot run this app.

## iOS usage Widget

The usage Widget shows Codex and Claude quota status. The containing app refreshes it through `RomeApiClient`, so the request carries the selected instance session explicitly. The Widget timeline receives only projected quota fields plus non-sensitive selected-instance metadata.

The Widget target shares the configured Keychain access group. Its timeline provider verifies `/api/auth/verify` without starting the containing app or a WebView, blocks redirects before they are followed, and can repeat the Core–Cloud instance authorization exchange when the stored Core session expires. It records only success/failure timestamps in App Group defaults; credentials never enter the timeline.

## Verification

Automated checks cover callback state and issuer checks, secure credential storage, origin-bound service selection, per-origin sessions, one-time refresh, redirect rejection, and concurrent session creation.

Real-device acceptance must cover:

1. Install the app fresh and confirm it shows the Native Launcher.
2. Finish Cloud login in the system authentication session and return to the app.
3. Confirm the service list contains only the signed-in account's services.
4. Confirm `/api/auth/verify` succeeds before the WebView opens.
5. Confirm the first WebView page is already authenticated.
6. Kill and reopen the app, then confirm it restores the selected service.
7. Switch services and confirm no session crosses origins.
8. Revoke the Cloud device in Rome Cloud and confirm the Launcher asks for sign-in.
9. Stop Rome Cloud and confirm an unexpired instance session still serves Native requests.
10. Confirm a cross-origin redirect never receives `rome_session`.
