# Suspensions

How a [suspension](../concepts/actions.md#suspensions) crosses the seam between the agent runtime, the server, and the host: which component owns the card and the resolution, and the correlation and trust rules that hold across reload and restart. The contracts callers observe — resolution outcomes, artifact ownership, and the off-webchat fallback — live on the [suspension concept](../concepts/actions.md#suspensions) and are not restated here.

```
action result ─► agent runtime ─► server ─► card in the caller's transcript ─► host
                 (caller parks)     │                                          │
                                    ▼                                          ▼
caller resumes ◄─ outcome prompt ◄─ server ◄──── resolution turn ◄──── commit or dismissal
```

## Correlation

### Invariants

- The chat stream is the only transport. The card is an ordinary persisted assistant message, and the resolution is an ordinary posted turn. No endpoint exposes suspension state, and the host never polls for it.
- Open state is derived, never stored. A suspension is open exactly when its card has no later resolution citing the same tool use id, so reload, reconnect, and restart all re-derive it from the transcript.
- The tool use id of the suspending call is the sole correlation key from tool result to card to resolution. Nothing else binds the three.

## Trust

### Invariants

- Resolution is fail-closed: a resolution citing no open card is rejected, so a stale, duplicate, or forged resolution never reaches the parked caller.
- The caller resumes on a server-built outcome prompt. The resolution turn carries only the artifact — the host never authors the text that re-drives the caller.
- Suspension is fail-closed: a card lands only when the owning app is installed and [declares the component](../concepts/apps.md). The host's built-in question card is the one card with no owning app.
- Dismissal is not a separate channel. A cancel affordance posts the same resolution message with a dismissal artifact, so it passes the same guard and lands in the same transcript.
