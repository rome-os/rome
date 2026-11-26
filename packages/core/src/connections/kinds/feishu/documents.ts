import { z } from "zod";
import type { ProfileRecord } from "../../types.js";
import { ProviderOperationError } from "../../errors.js";
import { documentId, operation, token, type RequestData } from "./operation.js";
export const FEISHU_DOCUMENT_READ = "feishu.document.read";
export const FEISHU_DOCUMENT_SCOPE = "docx:document:readonly";
const MAX_CONTENT_BYTES = 128 * 1024;
/** Only public profile fields may become provider-console links. */
export function feishuDocumentGuidance(profile?: ProfileRecord) {
  const appId =
    typeof profile?.appId === "string" && /^cli_[a-zA-Z0-9]+$/.test(profile.appId)
      ? profile.appId
      : null;
  const brands: Array<"feishu" | "lark"> =
    profile?.domain === "feishu" || profile?.domain === "lark"
      ? [profile.domain]
      : ["feishu", "lark"];
  return {
    scope: FEISHU_DOCUMENT_SCOPE,
    scopeStatus: "not_checked" as const,
    consoles: brands.map((brand) => ({
      brand,
      url: `${brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"}/app${appId ? `/${encodeURIComponent(appId)}/auth` : ""}`,
    })),
  };
}

export function feishuAppAccessGuidance(profile?: ProfileRecord) {
  const { url } = feishuDocumentGuidance(profile).consoles[0];
  const base = new URL(url).origin;
  return {
    consoleUrl: url.replace(/\/auth$/, ""),
    scopesUrl: url,
    docsUrl: base + "/document/server-docs/application-scope/introduction",
    scopeCheckOperation: "feishu.scopes.list",
  };
}

const docs = "/open-apis/docx/v1/documents";
const revisionId = z.int().positive();
const revision = z.object({ document_revision_id: revisionId });
const content = z.string().max(16_000);
function paragraphs(content: string) {
  if (!content) return [];
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 100) lines.splice(99, lines.length - 99, lines.slice(99).join("\n"));
  return lines.map((line) => ({
    block_type: 2,
    text: { elements: [{ text_run: { content: line } }] },
  }));
}

async function append(
  request: RequestData,
  url: string,
  children: ReturnType<typeof paragraphs>,
  revisionId?: number,
) {
  // Feishu accepts at most 50 children in one insertion.
  for (let offset = 0; offset < children.length; offset += 50) {
    const result = await request(
      {
        method: "POST",
        url,
        data: { children: children.slice(offset, offset + 50), index: -1 },
        params: { document_revision_id: revisionId },
      },
      revision,
    );
    revisionId = result.document_revision_id;
  }
  return revisionId;
}

const listedChildren = z.object({
  items: z.array(z.object({})),
  has_more: z.boolean(),
  page_token: z.string().max(4000).optional(),
});
async function countChildren(request: RequestData, url: string, revisionId: number) {
  let count = 0;
  let pageToken: string | undefined;
  const tokens = new Set<string>();
  do {
    const page = await request(
      {
        method: "GET",
        url,
        params: { document_revision_id: revisionId, page_size: 500, page_token: pageToken },
      },
      listedChildren,
    );
    count += page.items.length;
    if (!page.has_more) break;
    pageToken = page.page_token;
    if (!pageToken || tokens.has(pageToken))
      throw new ProviderOperationError("provider_response_invalid");
    if (tokens.size >= 100) throw new ProviderOperationError("provider_response_too_large");
    tokens.add(pageToken);
  } while (true);
  return count;
}

export const documentOperations = [
  operation(
    "document.read",
    "Read the plain text of one Docx document accessible to the connected bot.",
    z.strictObject({ documentId }),
    async ({ documentId }, request) => {
      const { content } = await request(
        { method: "GET", url: `${docs}/${documentId}/raw_content` },
        z.object({ content: z.string() }),
      );
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
        throw new ProviderOperationError("provider_response_too_large");
      return { documentId, content, format: "plain_text", complete: true };
    },
    { resourceConstraintKind: "documentIds" },
  ),
  operation(
    "document.create",
    "Create a Docx document with optional plain-text paragraphs.",
    z.strictObject({
      title: z.string().min(1).max(200),
      content: content.optional(),
      folderToken: token.optional(),
    }),
    async ({ title, content, folderToken }, request) => {
      const blocks = paragraphs(content ?? "");
      const { document } = await request(
        { method: "POST", url: docs, data: { title, folder_token: folderToken } },
        z.object({
          document: z.object({
            document_id: documentId,
            title: z.string(),
            revision_id: z.number().optional(),
          }),
        }),
      );
      const id = document.document_id;
      const revisionId = blocks.length
        ? await append(request, `${docs}/${id}/blocks/${id}/children`, blocks, document.revision_id)
        : document.revision_id;
      return { documentId: id, title: document.title, revisionId, blockCount: blocks.length };
    },
    {
      sideEffects: "write",
      approvalRequired: true,
      approvalPreview: {
        summary: "Create Feishu document",
        fields: [
          { label: "Title", inputPointer: "/title" },
          { label: "Folder token", inputPointer: "/folderToken" },
        ],
      },
    },
  ),
  operation(
    "document.update",
    "Append or replace plain-text paragraphs in a Docx document.",
    z.strictObject({ documentId, mode: z.enum(["append", "overwrite"]), content: content.min(1) }),
    async ({ documentId, mode, content }, request) => {
      const blocks = paragraphs(content);
      const url = `${docs}/${documentId}/blocks/${documentId}/children`;
      let currentRevision: number | undefined;
      let existingChildCount = 0;
      if (mode === "overwrite") {
        const { document } = await request(
          { method: "GET", url: `${docs}/${documentId}` },
          z.object({ document: z.object({ revision_id: revisionId }) }),
        );
        currentRevision = document.revision_id;
        existingChildCount = await countChildren(request, url, currentRevision);
      }
      currentRevision = await append(request, url, blocks, currentRevision);
      // Keep the original prefix until every replacement block is present at the pinned revision.
      if (existingChildCount > 0) {
        const result = await request(
          {
            method: "DELETE",
            url: url + "/batch_delete",
            params: { document_revision_id: currentRevision },
            data: { start_index: 0, end_index: existingChildCount },
          },
          revision,
        );
        currentRevision = result.document_revision_id;
      }
      return { documentId, mode, revisionId: currentRevision, blocksAdded: blocks.length };
    },
    {
      sideEffects: "write",
      approvalRequired: true,
      resourceConstraintKind: "documentIds",
      approvalPreview: {
        summary: "Update Feishu document",
        fields: [
          { label: "Document ID", inputPointer: "/documentId" },
          { label: "Mode", inputPointer: "/mode" },
        ],
      },
    },
  ),
];
