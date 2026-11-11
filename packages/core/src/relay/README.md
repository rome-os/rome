# Relay

The Rome Cloud relay: it drains the webhooks Rome Cloud holds for this instance and hands each to an app's public API.

## Imports

- Relay may import Apps and Instance, as [`lint/rules/contexts.ts`](../../../../lint/rules/contexts.ts) checks.
- It is imported by App host only.
