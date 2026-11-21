# Rome-managed Gmail

Gmail proxy calls prefer the Google connection held by core. Only absence falls
back to Composio. An identity-only or partially consented Google grant without
Gmail read permission also leaves Composio available. A broken Gmail grant does
not switch accounts. Composio connections,
tools, and events remain available.

Core keeps the Google credential inside its connection Actor, not a shared token
file. It allows only profile, message, and thread reads. Its separate send action
requires guardian approval for every exact message and uses the existing card.
The card shows From, To, Subject, and Body. Raw MIME, hidden recipients, uploads,
mailbox mutations, and arbitrary Google endpoints are not exposed.

Worker actions share the same approval contract and reach the main process over
the existing IPC service boundary. Tests cover reads and nested approved sends
across that boundary without mocking runAction.

Tests use fake credentials and provider replies. They cover routing, restricted
reads, approval/rejection, duplicate approval handling, and credential renewal.
No real Google consent or mailbox is used. Google stays hidden by default under
SHOW_GOOGLE_OAUTH until verification. Publish the Cloud policy before or with the
scope change, after the core approval implementation is deployed.
