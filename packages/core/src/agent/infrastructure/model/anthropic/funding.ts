import type { ClaudeLogin } from "../../../domain/model-login.js";
import type { ModelFunding } from "../../../domain/model-port.js";

/** Funding for a Claude query: an API credential is billed to the guardian's own key. */
export function anthropicFunding(login: ClaudeLogin): ModelFunding {
  return login.kind === "api_credential" ? "byok" : "subscription";
}
