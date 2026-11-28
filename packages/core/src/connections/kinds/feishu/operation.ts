import { feishuOperationScopes } from "@rome/api-types/app-connection-access";
import { z } from "zod";
import type { OperationDescriptor } from "../../types.js";
import type { Endpoint } from "./transport.js";

export type RequestData = <S extends z.ZodType>(
  endpoint: Endpoint,
  schema: S,
) => Promise<z.output<S>>;
export const token = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const documentId = z.string().regex(/^[a-zA-Z0-9]{1,128}$/);
export const text = z.string().optional();
export const number = z.number().optional();

export function pagination(max: number) {
  return {
    pageSize: z.int().min(1).max(max).optional(),
    pageToken: z.string().max(4000).optional(),
  };
}

export function pageParams(input: { pageSize?: number; pageToken?: string }) {
  return { page_size: input.pageSize, page_token: input.pageToken };
}

export function pageOf<S extends z.ZodType>(item: S) {
  return z
    .object({ items: z.array(item), has_more: z.boolean(), page_token: text })
    .transform((page) => ({
      items: page.items,
      hasMore: page.has_more,
      pageToken: page.page_token,
    }));
}

export function operation<S extends z.ZodType>(
  name: Parameters<typeof feishuOperationScopes>[0],
  description: string,
  input: S,
  run: (input: z.output<S>, request: RequestData) => Promise<unknown>,
  access: Partial<NonNullable<OperationDescriptor["appAccess"]>> = {},
) {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(input, { io: "input" });
  const descriptor: OperationDescriptor = {
    name: `feishu.${name}`,
    description,
    inputSchema,
    validateInput: (value) => input.safeParse(value).success,
    appAccess: {
      sideEffects: "read-only",
      ...feishuOperationScopes(name),
      ...access,
    },
  };
  return {
    descriptor,
    invoke: (value: unknown, request: RequestData) => run(input.parse(value), request),
  };
}
