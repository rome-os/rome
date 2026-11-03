import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { loadConnectorClient } from "../../shared.js";

const inputSchema = z.object({});

function loginCard(promptText: string) {
  return {
    status: "pending_interaction" as const,
    interaction: {
      appId: "connector",
      promptText,
      render: { kind: "inline" as const, componentId: "login-card", props: {} },
    },
  };
}

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async () => {
      const client = await loadConnectorClient();
      if (client) {
        // A saved key is not proof of a valid sign-in: Composio can revoke it.
        // Ping it, so an agent sent here after a 401 gets the card back instead
        // of a `signed_in` that sends it straight back into the same 401.
        const ping = await client.ping();
        if (ping.ok) {
          // Idempotent so the agent can call this defensively without ever
          // stacking a second sign-in card.
          return { status: "ok", data: { status: "signed_in" } };
        }
        if (ping.status !== 401) {
          // Composio is unreachable or failing. That says nothing about the
          // key, so neither report signed_in nor ask the owner to sign in again.
          return {
            status: "error",
            error: `Couldn't verify the Composio sign-in (${ping.status ? `HTTP ${ping.status}` : "no response"}): ${ping.message}. Try again shortly.`,
          };
        }
        return loginCard(
          "Composio rejected Rome's saved sign-in. Sign in again using the shown card, then re-run the action that failed.",
        );
      }
      // Not signed in: render the single inline sign-in card. Login is
      // request-host-coupled (the authorize tab opens in the owner's browser),
      // so it must originate in the component, not headlessly here. Sign-in is
      // account-wide, so this is the one place a login card is ever rendered —
      // connector_connect points the agent here instead of rendering its own,
      // which is what stops duplicate login cards when several toolkits are
      // connected in one turn.
      return loginCard(
        "Sign in to Composio using the shown card. This authorizes Rome account-wide — once signed in, re-run connector_connect for each toolkit you want to connect.",
      );
    },
  });
}
