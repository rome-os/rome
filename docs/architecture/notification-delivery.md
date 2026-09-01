# Notification Delivery

How a mobile push notification travels from an [instance](../concepts/deployment.md#instances) to a guardian's device, and the invariants that hold across the instance ↔ [Rome Cloud](../concepts/rome-cloud.md) ↔ push-provider boundary. A device receives push through its platform service — APNs for iOS, FCM for Android — and the notification itself originates from a user-directed [action](../concepts/actions.md).

## Components

- **Instance** — runs the agent and the notification action. Decides *whether* to notify and *what* the body says.
- **Rome Cloud** — the central push broker. Owns device registration, the push-provider credentials (APNs for iOS, FCM for Android), and the delivery fan-out.
- **APNs / FCM** — the platform push services (Apple's APNs for iOS, Google's FCM for Android), and the only path to the physical device.

## Invariants

- **An instance never contacts a push provider directly.** All push delivery goes through Rome Cloud. The instance only asks Rome Cloud to notify. The push-provider credentials (APNs and FCM) live solely on Rome Cloud and never on an instance, so a compromised instance cannot push to arbitrary devices.

- **A device's provider is fixed at registration, and dispatch after it is provider-agnostic.** Each device registers under exactly one provider — APNs for iOS, FCM for Android. Rome Cloud resolves the account and the body once, then delivers that same resolved content to each device via its provider. Only the per-device send leg varies by provider. The account-scoping, content-enforcement, no-secrets, and bounded-fire-and-forget invariants hold identically across providers. (Adding a provider also widens the device model and the registration path — the send leg is not its whole footprint.)

- **The owning account is derived from the credential, never named by the caller.** A notification request carries no account, user, or device identifier — Rome Cloud resolves the account from the authenticated instance token and fans out only to that account's registered devices. There is no cross-account delivery.

- **The title is fixed and broker-owned. The body is the only sender-supplied content.** Rome Cloud always sets the notification title and provides the default body. A request may override only the body.

- **Rome Cloud is the single content-enforcement point.** All validation, normalization, length-capping, and fallback of the body happen at the broker, once, before device lookup and delivery. The instance forwards the body unchanged and makes no content decisions.

- **Agent input is validated at the instance boundary before dispatch, independently of the broker.** The action fails closed on a malformed argument — a bad request never reaches Rome Cloud and never degrades into a default notification. This is a distinct layer from Rome Cloud's own request validation: the two do not rely on each other.

- **The notification body carries no secrets.** The body may be lock-screen-visible and is retained with the invocation, so it must not contain passwords, authentication codes, tokens, or other secrets. A notification may state that approval is required. It must not carry the secret itself. This is a behavioral rule, not a runtime-enforced filter.

- **Notification content is never written to operational logs.** Neither the instance nor Rome Cloud emits the body to logs. Logs carry only outcome and identifier metadata. (Invocation arguments are retained with the action record under the normal execution-history semantics — a separate concern from logging.)

- **A successful push-provider response (APNs or FCM) is acceptance, not confirmation of delivery or display.** Nothing downstream treats "sent" as "seen."

- **A delivery-ambiguous outcome is never auto-retried.** When a failure surfaces after dispatch — so delivery may already have happened — the result is reported as ambiguous and the caller must not retry without explicit authorization.

- **Delivery is bounded and fire-and-forget.** Each send fans out over the account's registered devices with a bounded per-request cap. There is no queue and no automatic retry.
