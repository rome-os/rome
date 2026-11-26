// Feishu: a Feishu or Lark app the guardian creates or pastes in. Nothing in
// Connections imports it, so leaving it out of the wiring leaves every other
// kind working. Vocabulary: docs/domains/connections.md.

import type { KindMount } from "../../kind-mount.js";
import { createFeishuDescriptor, type FeishuDescriptorDeps } from "./descriptor.js";

export type { FeishuDocumentRequest, FeishuRequest } from "./transport.js";
export type { FeishuDescriptorDeps } from "./descriptor.js";
export { FEISHU_DOCUMENT_READ, feishuDocumentGuidance } from "./documents.js";

export function feishu(deps: FeishuDescriptorDeps): KindMount {
  return { descriptor: createFeishuDescriptor(deps) };
}
