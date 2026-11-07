// The import rules for bounded contexts laid out as `<context>/<layer>`, as
// data. The engine that applies them is layer-boundaries.ts. The layout:
// DEVELOPMENT.md, "Established patterns".
//
// An import is judged by the file it resolves to. Each rule names the files it
// governs (`from`) and then either the only targets they may reach (`allow`)
// or the targets they must not reach (`deny`). A target is a set of layers in
// the importer's own context (`same`), in a different context (`other`), or
// code outside every context (`none`). Package imports are never judged. An
// import breaks the first rule that rejects it.

import type { LayerRules } from "./layer-boundaries.js";

export const LAYER_RULES: LayerRules = {
  contexts: ["agent"],
  rules: [
    {
      name: "domain-imports-domain",
      description:
        "The domain depends on nothing outward. A file in domain/ imports only its own context's domain/ and packages.",
      from: ["domain"],
      allow: [{ context: "same", layers: ["domain"] }],
    },
    {
      name: "application-imports-inward",
      description:
        "Use cases depend only on the model. A file in application/ imports only its own context's domain/, application/ and packages.",
      from: ["application"],
      allow: [{ context: "same", layers: ["domain", "application"] }],
    },
    {
      name: "infrastructure-imports-inward",
      description:
        "Adapters depend inward, never on what wires them. A file in infrastructure/ never imports its own context's application/ or index.ts.",
      from: ["infrastructure"],
      deny: [{ context: "same", layers: ["application", "index"] }],
    },
    {
      name: "enter-through-index",
      description:
        "A context's index.ts is its public module. Code outside a context imports nothing of it but index.ts.",
      deny: [{ context: "other", layers: ["domain", "application", "infrastructure", "other"] }],
    },
  ],
};
