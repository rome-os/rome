# @rome-os/libs

Shared runtime primitives used by Rome, Rome Cloud, and the Rome apps.

## Purpose

Rome Core and Rome Cloud participate in the same authentication, origin,
logging, and rollout flows. Those flows must agree on details such as PKCE
encoding, OIDC token verification, hostname classification, and feature-gate
fallback behavior. Keeping those primitives in one versioned package prevents
the two repositories from carrying implementations that can silently drift.

The package is configured for public publication because the open Rome
repository and the Rome Cloud repository both need to install it. It remains an
internal Rome building block rather than a supported app-author API. App authors
should use `@rome-os/app-runtime` and `@rome-os/app-web-sdk` instead.

After the repository split, the open Rome repository remains the source of
truth for this package. Rome Cloud consumes explicit released versions and
contributes shared changes back to Rome.

## Modules

There is intentionally no root export. Consumers import the smallest explicit
subpath so runtime-specific code is visible at the call site.

| Subpath | Responsibility |
| --- | --- |
| `@rome-os/libs/net` | Hostname predicates shared by origin and authorization checks. |
| `@rome-os/libs/pkce` | RFC 7636 S256 verifier generation, normalization, and verification. |
| `@rome-os/libs/oidc` | ES256 ID-token signing and verification, JWKS helpers, and discovery metadata. |
| `@rome-os/libs/native-auth` | Native app sign-in to Rome Cloud and hosted instances, shared by Rome Mobile and the desktop app. Uses global `fetch` and `URL` only, so it also runs under React Native. |
| `@rome-os/libs/logger` | Structured JSON logging and process-fatal error reporting. |
| `@rome-os/libs/feature-flags` | Vendor-neutral, fail-closed feature-gate evaluation. |
| `@rome-os/libs/feature-flags/statsig` | Statsig-backed production adapter. |
| `@rome-os/libs/feature-flags/env-overrides` | `FEATURE_GATE_*` environment overrides. |
| `@rome-os/libs/feature-flags/testing` | Offline feature-gate controls shared by Core and Cloud tests. |

For example:

```ts
import { createPkce } from "@rome-os/libs/pkce";
import { verifyIdToken } from "@rome-os/libs/oidc";
import { createLogger } from "@rome-os/libs/logger";
```

## Boundary

Code belongs here when all of the following are true:

- Rome Core and Rome Cloud both need the behavior.
- The behavior must stay identical across the repository boundary.
- It can be implemented without importing either application's database,
  routes, configuration objects, or other repository-local modules.
- It is appropriate for a Node.js runtime and can be tested independently.

The package must not contain Cloud persistence or provisioning logic, Rome
application orchestration, browser UI, or APIs intended for third-party app
authors. A helper used by only one repository should stay with that repository
until a real second consumer establishes the shared contract.
