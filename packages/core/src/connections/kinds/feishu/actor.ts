import { z } from "zod";
import type { Actor } from "../../types.js";
import { ProviderOperationError } from "../../errors.js";
import type { FeishuAppMaterial } from "./descriptor.js";
import { documentOperations, FEISHU_DOCUMENT_READ } from "./documents.js";
import { dataOperations, scopesList } from "./data-operations.js";
import { calendarOperations, messagesList } from "./calendar-im.js";
import type { RequestData } from "./operation.js";
import {
  createFeishuRequest,
  mapRequestError,
  responseError,
  type FeishuDocumentRequest,
  type FeishuRequest,
} from "./transport.js";

const operations = [
  scopesList,
  ...documentOperations,
  ...dataOperations,
  ...calendarOperations,
  messagesList,
];
export const FEISHU_OPERATIONS = operations.map((operation) => operation.descriptor);
const envelope = z.object({ code: z.number(), data: z.unknown().optional() });
const documentEnvelope = z.object({
  code: z.number(),
  data: z.object({ content: z.string() }).optional(),
});

export function createFeishuActor(
  material: FeishuAppMaterial,
  documentRequest?: FeishuDocumentRequest,
  request: FeishuRequest = createFeishuRequest(),
): Actor {
  const stopped = new AbortController();
  return {
    operations: () => FEISHU_OPERATIONS,
    stop: () => stopped.abort(),
    async invoke(call) {
      const op = operations.find(({ descriptor }) => descriptor.name === call.operation);
      if (!op) throw new Error("operation_not_found");
      const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(15_000)]);
      const documentRead = call.operation === FEISHU_DOCUMENT_READ;
      const requestData: RequestData = async (endpoint, schema) => {
        signal.throwIfAborted();
        let raw: unknown;
        try {
          raw =
            documentRead && documentRequest
              ? await documentRequest(
                  material,
                  (call.input as { documentId: string }).documentId,
                  signal,
                )
              : await request(material, endpoint, signal);
        } catch (error) {
          mapRequestError(error, documentRead);
        }
        signal.throwIfAborted();
        const parsed = (documentRead ? documentEnvelope : envelope).safeParse(raw);
        if (!parsed.success) throw new ProviderOperationError("provider_response_invalid");
        if (parsed.data.code !== 0) throw responseError(parsed.data, documentRead);
        const result = schema.safeParse(parsed.data.data);
        if (!result.success) throw new ProviderOperationError("provider_response_invalid");
        return result.data;
      };
      signal.throwIfAborted();
      let rejectAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new ProviderOperationError("provider_unavailable", true));
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      try {
        return await Promise.race([op.invoke(call.input, requestData), aborted]);
      } finally {
        signal.removeEventListener("abort", rejectAbort);
      }
    },
  };
}
