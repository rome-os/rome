import crypto from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { getProfileDir } from "../paths.js";
import { createLogger } from "../logger.js";
import type { ProviderAdapter } from "./adapter.js";
import type {
  Attachment,
  MessageReplyReference,
  NormalizedMessage,
  OutgoingMessage,
} from "./types.js";
import {
  isAllowedAttachmentUrl,
  readAttachmentResponseBody,
  saveIncomingAttachmentPayloads,
  type IncomingAttachmentPayload,
} from "./attachment-files.js";

const log = createLogger("wechat");

const CHANNEL_VERSION = "2.4.3";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);
const BOT_AGENT = "Rome/0.1.1";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const BOT_TYPE = "3";
const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const MAX_CONTEXT_TOKENS = 1_000;
const STALE_SESSION_ERRCODE = -14;
// Match Tencent's reference client: give a stale session one quiet hour before retrying.
const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1_000;

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_VIDEO = 5;

// MediaType values for getuploadurl (different from MSG_ITEM_* used in sendmessage)
const MEDIA_TYPE_IMAGE = 1;
const MEDIA_TYPE_VIDEO = 2;
const MEDIA_TYPE_FILE = 3;
const MEDIA_TYPE_VOICE = 4;

const UPLOAD_MAX_RETRIES = 3;

export const WECHAT_SETTINGS_KEY = "wechat";

export interface WechatSettings {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string | null;
  connectedAt: string;
  statePath?: string;
}

/**
 * Runtime config for {@link WechatAdapter}: the persisted settings plus the
 * optional fault seam the Talker wires in. `onFault` fires ONLY on a
 * terminal outcome the adapter cannot recover — a refused credential (ilinkai
 * HTTP 401/403, see {@link isWechatAuthError}). Transient getupdates failures
 * retry internally. ChannelManager passes no callback, so failures are only
 * logged.
 */
export interface WechatAdapterConfig extends WechatSettings {
  onFault?: (err: unknown) => void;
}

/**
 * True iff `err` is an ilinkai "credential refused" — an HTTP 401/403 raised by
 * {@link apiFetch} during the long-poll. This is the ONLY WeChat signal that
 * maps to grant state; every other transport failure is retried
 * internally and, if terminal, is a `Disconnected`.
 */
export function isWechatAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /^HTTP 40[13]\b/.test(err.message);
}

export type WechatConnectionStatus = "disconnected" | "connecting" | "open" | "error";

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

interface TextItem {
  text?: string;
}

interface ImageItem {
  aes_key?: string;
  aeskey?: string;
  cdn_url?: string;
  encrypt_query_param?: string;
  encrypted_query_param?: string;
  media?: CDNMedia;
  width?: number;
  height?: number;
  media_id?: string;
}

interface CDNMedia {
  aes_key?: string;
  aeskey?: string;
  cdn_url?: string;
  encrypt_query_param?: string;
  encrypted_query_param?: string;
  media_id?: string;
}

interface VoiceItem {
  text?: string;
  aes_key?: string;
  aeskey?: string;
  cdn_url?: string;
  encrypt_query_param?: string;
  encrypted_query_param?: string;
  media?: CDNMedia;
  duration_ms?: number;
}

interface FileItem {
  file_name?: string;
  file_size?: number;
  aes_key?: string;
  aeskey?: string;
  cdn_url?: string;
  encrypt_query_param?: string;
  encrypted_query_param?: string;
  media?: CDNMedia;
  media_id?: string;
}

interface VideoItem {
  aes_key?: string;
  aeskey?: string;
  cdn_url?: string;
  encrypt_query_param?: string;
  encrypted_query_param?: string;
  media?: CDNMedia;
  duration_ms?: number;
  thumb_cdn_url?: string;
  media_id?: string;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface MessageItem {
  type?: number;
  msg_id?: number | string;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}

export interface WechatMessage {
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface UploadUrlResp {
  upload_param?: string;
  upload_full_url?: string;
  ret?: number;
  filekey: string;
}

type ExtractedContent = {
  text: string;
  attachments: Attachment[];
  messageId?: string;
  replyTo?: MessageReplyReference;
};

type WechatSendTarget = {
  to: string;
  contextToken: string;
};

interface WechatMediaRef {
  aesKey?: string;
  downloadUrl?: string;
  encryptQueryParam?: string;
}

interface WechatAttachment extends Attachment {
  wechatMedia?: WechatMediaRef;
}

interface LoginAttempt {
  id: string;
  baseUrl: string;
  qrcode: string;
  qrContent: string;
  createdAt: number;
  /** Set once the provider reports the scan confirmed. The attempt is retained
   *  (with this cached account) until the route's ledger conferral succeeds and
   *  calls `completeLogin`, so a transient conferral failure is retryable from
   *  the cache without redoing the QR scan. */
  confirmedAccount?: WechatSettings;
}

export function getDefaultWechatStatePath(): string {
  return join(getProfileDir(), "wechat");
}

export function normalizeWechatBaseUrl(baseUrl = DEFAULT_BASE_URL): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Invalid WeChat baseUrl");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isAllowedHost = hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !isAllowedHost
  ) {
    throw new Error("Invalid WeChat baseUrl");
  }

  return parsed.origin;
}

function normalizeBaseUrl(baseUrl: string): string {
  return `${normalizeWechatBaseUrl(baseUrl)}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: BOT_AGENT,
  };
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const url = new URL(params.endpoint, normalizeBaseUrl(params.baseUrl)).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(params.token, params.body),
      body: params.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  // WeChat ilink image uploads require AES-128-ECB; do not reuse this mode elsewhere.
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function decryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseWechatAesKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;

  if (/^[a-f0-9]{32}$/i.test(value)) {
    return Buffer.from(value, "hex");
  }

  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 16) return decoded;

    const decodedText = decoded.toString("utf-8").trim();
    if (/^[a-f0-9]{32}$/i.test(decodedText)) {
      return Buffer.from(decodedText, "hex");
    }
  } catch {
    return null;
  }

  return null;
}

function extractWechatMediaRef(
  item: ImageItem | VoiceItem | FileItem | VideoItem | CDNMedia | undefined,
): WechatMediaRef | undefined {
  if (!item) return undefined;
  const nested = "media" in item ? item.media : undefined;
  const source = nested ?? item;
  const aesKey = source.aes_key ?? source.aeskey ?? ("aeskey" in item ? item.aeskey : undefined);
  const downloadUrl = source.cdn_url ?? ("cdn_url" in item ? item.cdn_url : undefined);
  const encryptQueryParam =
    source.encrypt_query_param ??
    source.encrypted_query_param ??
    ("encrypt_query_param" in item ? item.encrypt_query_param : undefined) ??
    ("encrypted_query_param" in item ? item.encrypted_query_param : undefined);

  if (!aesKey && !encryptQueryParam) return undefined;
  return { aesKey, downloadUrl, encryptQueryParam };
}

function buildWechatDownloadUrl(media: WechatMediaRef): string | undefined {
  if (media.downloadUrl?.trim()) return media.downloadUrl.trim();
  if (!media.encryptQueryParam?.trim()) return undefined;

  const url = new URL("download", `${DEFAULT_CDN_BASE_URL}/`);
  url.searchParams.set("encrypted_query_param", media.encryptQueryParam.trim());
  return url.toString();
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    normalizeBaseUrl(baseUrl),
  );
  const res = await fetch(url.toString(), { headers: buildCommonHeaders() });
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    normalizeBaseUrl(baseUrl),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url.toString(), {
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

async function getTypingTicket(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
): Promise<string | null> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        ilink_user_id: toUserId,
        context_token: contextToken,
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: 5_000,
    });
    const resp = JSON.parse(raw) as { typing_ticket?: string };
    return resp.typing_ticket ?? null;
  } catch {
    return null;
  }
}

async function sendTyping(
  baseUrl: string,
  token: string,
  toUserId: string,
  typingTicket: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status: 1,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 5_000,
  });
}

function generateClientId(): string {
  return `rome-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 15_000,
  });
}

function encodeAesKeyHex(key: Buffer): string {
  return key.toString("hex");
}

// New upload protocol requires base64(hex(key)), not base64(raw_bytes)
function encodeAesKeyBase64(key: Buffer): string {
  return Buffer.from(key.toString("hex"), "utf-8").toString("base64");
}

async function getUploadUrl(
  baseUrl: string,
  token: string,
  toUserId: string,
  mediaType: number,
  rawData: Buffer,
  encryptedSize: number,
  aesKeyHex: string,
): Promise<UploadUrlResp> {
  const filekey = crypto.randomBytes(16).toString("hex");
  const rawMd5 = crypto.createHash("md5").update(rawData).digest("hex");
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawData.length,
      rawfilemd5: rawMd5,
      filesize: encryptedSize,
      aeskey: aesKeyHex,
      no_need_thumb: true,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 10_000,
  });
  const resp = JSON.parse(raw) as Omit<UploadUrlResp, "filekey">;
  return { ...resp, filekey };
}

class CdnClientError extends Error {
  constructor(public status: number) {
    super(`CDN upload client error ${status}`);
  }
}

async function uploadToCdn(uploadUrl: string, encryptedData: Buffer): Promise<string> {
  let encryptQueryParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(encryptedData.length),
        },
        body: new Uint8Array(encryptedData),
        signal: AbortSignal.timeout(60_000),
      });

      const retryableClientStatuses = new Set([408, 429]);
      if (res.status >= 400 && res.status < 500 && !retryableClientStatuses.has(res.status)) {
        throw new CdnClientError(res.status);
      }
      if (!res.ok) {
        throw new Error(`CDN upload failed with status ${res.status}`);
      }

      encryptQueryParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!encryptQueryParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      return encryptQueryParam;
    } catch (err) {
      lastError = err;
      if (err instanceof CdnClientError) throw err;
      if (attempt >= UPLOAD_MAX_RETRIES) break;
      log.warn(`CDN upload attempt ${attempt} failed, retrying`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
}

function buildMediaItem(
  msgItemType: number,
  encryptQueryParam: string,
  aesKeyBase64: string,
  fileName?: string,
  fileSize?: number,
): Record<string, unknown> {
  const media = { encrypt_query_param: encryptQueryParam, aes_key: aesKeyBase64, encrypt_type: 1 };
  switch (msgItemType) {
    case MSG_ITEM_IMAGE:
      return { type: MSG_ITEM_IMAGE, image_item: { media } };
    case MSG_ITEM_VOICE:
      return { type: MSG_ITEM_VOICE, voice_item: { media } };
    case MSG_ITEM_FILE:
      return {
        type: MSG_ITEM_FILE,
        file_item: { media, file_name: fileName, len: fileSize?.toString() },
      };
    case MSG_ITEM_VIDEO:
      return { type: MSG_ITEM_VIDEO, video_item: { media } };
    default:
      return {
        type: MSG_ITEM_FILE,
        file_item: { media, file_name: fileName, len: fileSize?.toString() },
      };
  }
}

function msgItemToUploadMediaType(msgItemType: number): number {
  switch (msgItemType) {
    case MSG_ITEM_IMAGE:
      return MEDIA_TYPE_IMAGE;
    case MSG_ITEM_VIDEO:
      return MEDIA_TYPE_VIDEO;
    case MSG_ITEM_VOICE:
      return MEDIA_TYPE_VOICE;
    default:
      return MEDIA_TYPE_FILE;
  }
}

async function sendMediaMessage(
  baseUrl: string,
  token: string,
  to: string,
  data: Buffer,
  contextToken: string,
  msgItemType: number,
  fileName?: string,
): Promise<void> {
  const aesKey = crypto.randomBytes(16);
  const encrypted = encryptAesEcb(data, aesKey);
  const uploadMediaType = msgItemToUploadMediaType(msgItemType);

  const uploadResp = await getUploadUrl(
    baseUrl,
    token,
    to,
    uploadMediaType,
    data,
    encrypted.length,
    encodeAesKeyHex(aesKey),
  );

  const uploadUrl =
    uploadResp.upload_full_url?.trim() ||
    (uploadResp.upload_param
      ? `${DEFAULT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(uploadResp.filekey)}`
      : null);

  if (!uploadUrl) {
    throw new Error(`getuploadurl returned no upload URL: ${JSON.stringify(uploadResp)}`);
  }

  const encryptQueryParam = await uploadToCdn(uploadUrl, encrypted);
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [
          buildMediaItem(
            msgItemType,
            encryptQueryParam,
            encodeAesKeyBase64(aesKey),
            fileName,
            data.length,
          ),
        ],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 15_000,
  });
}

function inferMessageItemType(item: MessageItem): number | undefined {
  if (item.text_item?.text) return MSG_ITEM_TEXT;
  if (item.voice_item) return MSG_ITEM_VOICE;
  if (item.image_item) return MSG_ITEM_IMAGE;
  if (item.file_item) return MSG_ITEM_FILE;
  if (item.video_item) return MSG_ITEM_VIDEO;
  return undefined;
}

function extractMessageItemContent(item: MessageItem): ExtractedContent | null {
  const inferredType = inferMessageItemType(item);
  const itemType =
    item.type === MSG_ITEM_TEXT && item.text_item?.text
      ? MSG_ITEM_TEXT
      : item.type === MSG_ITEM_VOICE && item.voice_item
        ? MSG_ITEM_VOICE
        : item.type === MSG_ITEM_IMAGE && item.image_item
          ? MSG_ITEM_IMAGE
          : item.type === MSG_ITEM_FILE && item.file_item
            ? MSG_ITEM_FILE
            : item.type === MSG_ITEM_VIDEO && item.video_item
              ? MSG_ITEM_VIDEO
              : inferredType;

  switch (itemType) {
    case MSG_ITEM_TEXT: {
      if (!item.text_item?.text) return null;
      return { text: item.text_item.text, attachments: [] };
    }
    case MSG_ITEM_VOICE: {
      const transcript = item.voice_item?.text;
      const media = extractWechatMediaRef(item.voice_item);
      return {
        text: transcript
          ? `[Voice transcript] ${transcript}`
          : "[Voice message without transcript]",
        attachments: [
          {
            type: "audio",
            url: buildWechatDownloadUrl(media ?? {}) ?? item.voice_item?.cdn_url,
            mimeType: "audio/*",
            ...(media ? { wechatMedia: media } : {}),
          },
        ] as WechatAttachment[],
      };
    }
    case MSG_ITEM_IMAGE: {
      const img = item.image_item;
      const media = extractWechatMediaRef(img);
      const dims = img?.width && img?.height ? ` (${img.width}x${img.height})` : "";
      return {
        text: `[Image${dims}]`,
        attachments: [
          {
            type: "image",
            url: buildWechatDownloadUrl(media ?? {}) ?? img?.cdn_url,
            fileName: "wechat-image.jpg",
            mimeType: "image/jpeg",
            ...(media ? { wechatMedia: media } : {}),
          },
        ] as WechatAttachment[],
      };
    }
    case MSG_ITEM_FILE: {
      const f = item.file_item;
      const media = extractWechatMediaRef(f);
      const name = f?.file_name ? ` "${f.file_name}"` : "";
      const size = f?.file_size ? ` (${(f.file_size / 1024).toFixed(1)} KB)` : "";
      return {
        text: `[File${name}${size}]`,
        attachments: [
          {
            type: "document",
            url: buildWechatDownloadUrl(media ?? {}) ?? f?.cdn_url,
            fileName: f?.file_name,
            ...(media ? { wechatMedia: media } : {}),
          },
        ] as WechatAttachment[],
      };
    }
    case MSG_ITEM_VIDEO: {
      const v = item.video_item;
      const media = extractWechatMediaRef(v);
      const dur = v?.duration_ms ? ` (${(v.duration_ms / 1000).toFixed(1)}s)` : "";
      return {
        text: `[Video${dur}]`,
        attachments: [
          {
            type: "video",
            url: buildWechatDownloadUrl(media ?? {}) ?? v?.cdn_url,
            ...(media ? { wechatMedia: media } : {}),
          },
        ] as WechatAttachment[],
      };
    }
    default:
      if (item.type === undefined || item.type === 0) return null;
      return { text: `[Unknown WeChat message type ${item.type}]`, attachments: [] };
  }
}

function normalizeWechatMessageId(value: string | number | undefined): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized && !/^0+$/.test(normalized) ? normalized : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value !== 0) return String(value);
  return undefined;
}

function referencedMessageContent(ref: RefMessage | undefined): string | undefined {
  const content = ref?.message_item
    ? extractMessageItemContent(ref.message_item)?.text.trim()
    : undefined;
  return content || ref?.title?.trim() || undefined;
}

function quotedMessagePrefix(ref: RefMessage | undefined): string | null {
  if (!ref) return null;
  const parts: string[] = [];
  if (ref.title?.trim()) parts.push(ref.title.trim());
  if (ref.message_item) {
    const quoted = extractMessageItemContent(ref.message_item);
    if (quoted?.text && !parts.includes(quoted.text)) parts.push(quoted.text);
  }
  return parts.length > 0 ? `[Quoted: ${parts.join(" | ")}]` : null;
}

function logReplyReferences(msg: WechatMessage): void {
  for (const [itemIndex, item] of (msg.item_list ?? []).entries()) {
    const ref = item.ref_msg;
    if (!ref) continue;

    const referencedItem = ref.message_item;
    const payloadFields = referencedItem
      ? [
          referencedItem.text_item ? "text_item" : null,
          referencedItem.image_item ? "image_item" : null,
          referencedItem.voice_item ? "voice_item" : null,
          referencedItem.file_item ? "file_item" : null,
          referencedItem.video_item ? "video_item" : null,
        ].filter((field): field is string => field !== null)
      : [];

    // Keep message contents, credentials, and media download references out of
    // this structural diagnostic. Field presence is enough to troubleshoot the
    // iLink reply shape without copying private conversation text into logs.
    log.info("reply reference received", {
      envelopeMessageId: msg.message_id ?? null,
      itemIndex,
      currentItemType: item.type ?? null,
      currentItemMessageId: item.msg_id ?? null,
      refTitlePresent: Boolean(ref.title?.trim()),
      referencedItemType: referencedItem?.type ?? null,
      referencedItemMessageId: referencedItem?.msg_id ?? null,
      referencedPayloadFields: payloadFields,
      referencedTextPresent: Boolean(referencedItem?.text_item?.text?.trim()),
      referencedVoiceTextPresent: Boolean(referencedItem?.voice_item?.text?.trim()),
    });
  }
}

function extractContent(msg: WechatMessage): ExtractedContent | null {
  if (!msg.item_list?.length) return null;

  for (const item of msg.item_list) {
    const extracted = extractMessageItemContent(item);
    if (!extracted) continue;

    const referencedItem = item.ref_msg?.message_item;
    const referencedContent = referencedMessageContent(item.ref_msg);
    const replyToMessageId = normalizeWechatMessageId(referencedItem?.msg_id);
    const fallbackQuote = replyToMessageId ? null : quotedMessagePrefix(item.ref_msg);
    return {
      ...extracted,
      text: fallbackQuote ? `${fallbackQuote}\n${extracted.text}` : extracted.text,
      messageId: normalizeWechatMessageId(item.msg_id),
      replyTo: replyToMessageId
        ? {
            messageId: replyToMessageId,
            ...(referencedContent ? { content: referencedContent } : {}),
          }
        : undefined,
    };
  }
  return null;
}

export function normalizeWechatMessage(msg: WechatMessage): NormalizedMessage | null {
  if (msg.message_type !== MSG_TYPE_USER) return null;

  const extracted = extractContent(msg);
  if (!extracted) return null;

  const senderId = msg.from_user_id?.trim() || "unknown";
  const rawGroupId = msg.group_id?.trim();
  const groupId = rawGroupId || undefined;
  const threadId = senderId;
  const senderShort = senderId.split("@")[0] || senderId;

  return {
    id:
      extracted.messageId ??
      normalizeWechatMessageId(msg.message_id) ??
      msg.client_id ??
      `${threadId}:${msg.create_time_ms ?? Date.now()}`,
    channel: "wechat",
    channelUserId: senderId,
    displayName: senderShort,
    threadId,
    threadName: groupId,
    threadType: groupId ? "group" : "private",
    timestamp: new Date(msg.create_time_ms ?? Date.now()),
    text: extracted.text,
    attachments: extracted.attachments.filter((att) => att.url || att.fileName || att.mimeType),
    ...(extracted.replyTo ? { replyTo: extracted.replyTo } : {}),
    // WeChat group traffic is partitioned by senderId, so a command can only
    // address that sender's Rome conversation, never another group member's.
    addressing: "direct",
    rawEvent: msg,
  };
}

function stripWechatMedia(attachment: Attachment): Attachment {
  const rest = { ...(attachment as WechatAttachment) };
  delete rest.wechatMedia;
  return rest;
}

async function downloadWechatAttachmentPayload(
  sourceAttachment: Attachment,
  savedAttachment: Attachment,
): Promise<IncomingAttachmentPayload | null> {
  const media = (sourceAttachment as WechatAttachment).wechatMedia;
  const downloadUrl = media ? buildWechatDownloadUrl(media) : sourceAttachment.url;
  if (!downloadUrl) return null;

  try {
    if (!isAllowedAttachmentUrl(downloadUrl)) {
      throw new Error("blocked attachment URL host");
    }

    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new Error(`download failed with ${response.status}`);
    }

    let data = await readAttachmentResponseBody(response);
    const aesKey = parseWechatAesKey(media?.aesKey);
    if (aesKey) {
      data = decryptAesEcb(data, aesKey);
    }

    return {
      attachment: savedAttachment,
      data,
      mimeType: savedAttachment.mimeType ?? response.headers.get("content-type") ?? undefined,
      fileName: savedAttachment.fileName,
    };
  } catch (err) {
    let host = "invalid";
    try {
      host = new URL(downloadUrl).hostname;
    } catch {
      // Keep the logged URL summary non-sensitive and structured.
    }
    log.warn("failed to download wechat attachment", {
      host,
      type: savedAttachment.type,
      fileName: savedAttachment.fileName ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function writeTextFile(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

export class WechatAuthService {
  private attempts = new Map<string, LoginAttempt>();

  async startLogin(baseUrl = DEFAULT_BASE_URL): Promise<{
    attemptId: string;
    qrContent: string;
    expiresAt: string;
  }> {
    const normalizedBaseUrl = normalizeWechatBaseUrl(baseUrl);
    this.pruneAttempts();
    const qr = await fetchQRCode(normalizedBaseUrl);
    const attempt: LoginAttempt = {
      id: uuidv4(),
      baseUrl: normalizedBaseUrl,
      qrcode: qr.qrcode,
      qrContent: qr.qrcode_img_content,
      createdAt: Date.now(),
    };
    this.attempts.set(attempt.id, attempt);
    return {
      attemptId: attempt.id,
      qrContent: attempt.qrContent,
      expiresAt: new Date(attempt.createdAt + 8 * 60_000).toISOString(),
    };
  }

  async pollLogin(
    attemptId: string,
  ): Promise<
    { status: "wait" | "scaned" | "expired" } | { status: "confirmed"; account: WechatSettings }
  > {
    this.pruneAttempts();
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { status: "expired" };

    // A previously-confirmed attempt whose ledger conferral failed: answer from
    // the cache (the provider's QR is single-use post-scan) so the route can
    // retry the conferral without a new scan.
    if (attempt.confirmedAccount) {
      return { status: "confirmed", account: attempt.confirmedAccount };
    }

    const status = await pollQRStatus(attempt.baseUrl, attempt.qrcode);
    if (status.status !== "confirmed") {
      if (status.status === "expired") this.attempts.delete(attemptId);
      return { status: status.status };
    }

    if (!status.ilink_bot_id || !status.bot_token) {
      throw new Error("WeChat login confirmed without bot credentials");
    }

    // Return the confirmed account to the route WITHOUT persisting it: the route
    // confers it directly into the grant ledger. The
    // attempt is retained (account cached) until `completeLogin`, so the only
    // copy of the confirmed credential can never be discarded by a failed
    // conferral.
    const account: WechatSettings = {
      token: status.bot_token,
      baseUrl: normalizeWechatBaseUrl(status.baseurl || attempt.baseUrl),
      accountId: status.ilink_bot_id,
      userId: status.ilink_user_id ?? null,
      connectedAt: new Date().toISOString(),
      statePath: getDefaultWechatStatePath(),
    };
    attempt.confirmedAccount = account;
    return { status: "confirmed", account };
  }

  /** Discard a confirmed attempt once its account has been conferred into the
   *  grant ledger. Until this is called, `pollLogin` keeps answering from the
   *  cached confirmed account so a failed conferral is retryable. */
  completeLogin(attemptId: string): void {
    this.attempts.delete(attemptId);
  }

  private pruneAttempts(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, attempt] of this.attempts) {
      if (attempt.createdAt < cutoff) this.attempts.delete(id);
    }
  }
}

export class WechatAdapter implements ProviderAdapter {
  readonly channelName = "wechat";
  private handler?: (msg: NormalizedMessage) => Promise<void>;
  private stopped = true;
  private pollGeneration = 0;
  private contextTokens = new Map<string, string>();
  private typingTargets = new Map<string, string>();
  private connectionStatus: WechatConnectionStatus = "disconnected";
  private lastError: string | null = null;
  private sessionPausedUntil = 0;
  private pollDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvePollDelay: (() => void) | null = null;

  private readonly onFault?: (err: unknown) => void;

  constructor(private config: WechatAdapterConfig) {
    this.onFault = config.onFault;
  }

  async start(): Promise<void> {
    this.cancelPollDelay();
    this.stopped = false;
    if (this.getRemainingSessionPauseMs() > 0) {
      this.connectionStatus = "error";
    } else {
      this.connectionStatus = "connecting";
      this.lastError = null;
    }
    this.contextTokens = await this.loadContextTokens();
    const generation = ++this.pollGeneration;
    this.poll(generation).catch((err) => {
      if (generation !== this.pollGeneration) return;
      this.connectionStatus = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      log.error("polling stopped", { error: this.lastError });
      // A terminal poll failure the loop could not swallow — surface it so the
      // Talker maps it (auth → CredentialRejected, else Disconnected).
      this.onFault?.(err);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pollGeneration += 1;
    this.cancelPollDelay();
    this.connectionStatus = "disconnected";
  }

  async sendMessage(
    channelUserId: string,
    threadId: string,
    message: OutgoingMessage,
  ): Promise<void> {
    this.assertSessionActive();
    const target = this.resolveSendTarget(channelUserId, threadId);

    if (message.text) {
      await sendTextMessage(
        this.config.baseUrl,
        this.config.token,
        target.to,
        message.text,
        target.contextToken,
      );
    }

    for (const attachment of message.attachments ?? []) {
      const mediaType =
        attachment.type === "image"
          ? MSG_ITEM_IMAGE
          : attachment.type === "video"
            ? MSG_ITEM_VIDEO
            : attachment.type === "audio"
              ? MSG_ITEM_VOICE
              : MSG_ITEM_FILE;
      const data = await readFile(attachment.source);
      const fileName =
        attachment.type === "document" || attachment.type === "audio"
          ? basename(attachment.source)
          : undefined;
      await sendMediaMessage(
        this.config.baseUrl,
        this.config.token,
        target.to,
        data,
        target.contextToken,
        mediaType,
        fileName,
      );
    }
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async saveIncomingAttachments(message: NormalizedMessage): Promise<Attachment[]> {
    const attachments = message.attachments.map(stripWechatMedia);
    const payloads: IncomingAttachmentPayload[] = [];

    for (const [index, sourceAttachment] of message.attachments.entries()) {
      const payload = await downloadWechatAttachmentPayload(sourceAttachment, attachments[index]);
      if (payload) payloads.push(payload);
    }

    if (payloads.length === 0) return attachments;
    return saveIncomingAttachmentPayloads({ ...message, attachments }, payloads);
  }

  async notifyTyping(threadId: string): Promise<void> {
    this.assertSessionActive();
    const contextToken = this.contextTokens.get(threadId);
    if (!contextToken) return;
    const target = this.typingTargets.get(threadId) ?? threadId;
    const ticket = await getTypingTicket(
      this.config.baseUrl,
      this.config.token,
      target,
      contextToken,
    );
    if (!ticket) return;
    await sendTyping(this.config.baseUrl, this.config.token, target, ticket);
  }

  getConnectionState(): {
    status: WechatConnectionStatus;
    accountId: string | null;
    userId: string | null;
    lastError: string | null;
  } {
    return {
      status: this.connectionStatus,
      accountId: this.config.accountId ?? null,
      userId: this.config.userId ?? null,
      lastError: this.lastError,
    };
  }

  /** Runtime-only health for the Connections surface. A stale session keeps
   * its credential and poll cursor, so it is degraded rather than disconnected
   * while Tencent's one-hour cooldown is active. */
  getRuntimeDegradation(): { reason: string; retryAt: string } | null {
    if (this.getRemainingSessionPauseMs() === 0) return null;
    return {
      reason: "WeChat reported a stale session. Rome will retry automatically after the cooldown.",
      retryAt: new Date(this.sessionPausedUntil).toISOString(),
    };
  }

  async clearState(): Promise<void> {
    await rm(this.statePath(), { recursive: true, force: true });
    this.contextTokens.clear();
  }

  private async poll(generation: number): Promise<void> {
    let getUpdatesBuf = (await readTextFile(this.syncBufPath())) ?? "";
    let consecutiveFailures = 0;
    this.connectionStatus = this.getRemainingSessionPauseMs() > 0 ? "error" : "open";

    while (!this.stopped && generation === this.pollGeneration) {
      const remainingPauseMs = this.getRemainingSessionPauseMs();
      if (remainingPauseMs > 0) {
        await this.waitForPollDelay(remainingPauseMs);
        continue;
      }

      try {
        const resp = await getUpdates(this.config.baseUrl, this.config.token, getUpdatesBuf);
        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (isError) {
          if (resp.ret === STALE_SESSION_ERRCODE || resp.errcode === STALE_SESSION_ERRCODE) {
            consecutiveFailures = 0;
            this.pauseSession(resp.errmsg);
            await this.waitForPollDelay(this.getRemainingSessionPauseMs());
            continue;
          }

          consecutiveFailures += 1;
          this.lastError = `getupdates failed: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`;
          log.warn("getupdates failed", {
            ret: resp.ret,
            errcode: resp.errcode,
            errmsg: resp.errmsg,
          });
          await this.delayAfterFailure(consecutiveFailures);
          continue;
        }

        consecutiveFailures = 0;
        this.lastError = null;
        this.connectionStatus = "open";

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
          await writeTextFile(this.syncBufPath(), getUpdatesBuf).catch(() => {});
        }

        for (const raw of resp.msgs ?? []) {
          await this.handleRawMessage(raw);
        }
      } catch (err) {
        // A refused credential is terminal: stop the loop and let it propagate
        // to start()'s catch → onFault → CredentialRejected. Everything else
        // stays adapter-internal retry (backoff + continue).
        if (isWechatAuthError(err)) throw err;
        consecutiveFailures += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        log.warn("polling error", { error: this.lastError });
        await this.delayAfterFailure(consecutiveFailures);
      }
    }
  }

  private async handleRawMessage(raw: WechatMessage): Promise<void> {
    logReplyReferences(raw);
    const normalized = normalizeWechatMessage(raw);
    if (!normalized) return;

    if (raw.context_token) {
      this.rememberContextToken(normalized.threadId, raw.context_token, normalized.channelUserId);
      this.rememberContextToken(
        normalized.channelUserId,
        raw.context_token,
        normalized.channelUserId,
      );
      await this.saveContextTokens().catch(() => {});
    }

    if (!this.handler) return;

    try {
      await this.handler(normalized);
    } catch (err) {
      log.error("message handler error", {
        messageId: normalized.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveSendTarget(channelUserId: string, threadId: string): WechatSendTarget {
    const keys = [channelUserId, threadId].filter((value, index, all) => {
      return value.trim() && all.indexOf(value) === index;
    });

    for (const key of keys) {
      const contextToken = this.contextTokens.get(key);
      if (!contextToken) continue;
      return {
        to: this.typingTargets.get(key) ?? (channelUserId.trim() || threadId.trim() || key),
        contextToken,
      };
    }

    const target = channelUserId.trim() || threadId.trim();
    throw new Error(
      `No WeChat context token for ${target}. The user must send a new message first.`,
    );
  }

  private async delayAfterFailure(consecutiveFailures: number): Promise<void> {
    const delay =
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.connectionStatus = "error";
    }
    await this.waitForPollDelay(delay);
  }

  private pauseSession(errmsg?: string): void {
    this.sessionPausedUntil = Date.now() + SESSION_PAUSE_DURATION_MS;
    this.connectionStatus = "error";
    this.lastError = `getupdates paused: errcode=${STALE_SESSION_ERRCODE} ${errmsg ?? ""}`.trim();
    log.warn("wechat session paused", {
      accountId: this.config.accountId,
      errcode: STALE_SESSION_ERRCODE,
      errmsg,
      retryAt: new Date(this.sessionPausedUntil).toISOString(),
    });
  }

  private getRemainingSessionPauseMs(): number {
    const remaining = this.sessionPausedUntil - Date.now();
    if (remaining <= 0) {
      this.sessionPausedUntil = 0;
      return 0;
    }
    return remaining;
  }

  private assertSessionActive(): void {
    const remainingMs = this.getRemainingSessionPauseMs();
    if (remainingMs === 0) return;
    const remainingMinutes = Math.ceil(remainingMs / 60_000);
    throw new Error(
      `WeChat session paused after errcode ${STALE_SESSION_ERRCODE}; retry in ${remainingMinutes} min`,
    );
  }

  private waitForPollDelay(delayMs: number): Promise<void> {
    this.cancelPollDelay();
    return new Promise((resolve) => {
      this.resolvePollDelay = resolve;
      this.pollDelayTimer = setTimeout(() => {
        this.pollDelayTimer = null;
        this.resolvePollDelay = null;
        resolve();
      }, delayMs);
    });
  }

  private cancelPollDelay(): void {
    if (this.pollDelayTimer !== null) {
      clearTimeout(this.pollDelayTimer);
      this.pollDelayTimer = null;
    }
    const resolve = this.resolvePollDelay;
    this.resolvePollDelay = null;
    resolve?.();
  }

  private statePath(): string {
    return this.config.statePath || getDefaultWechatStatePath();
  }

  private syncBufPath(): string {
    return join(this.statePath(), "sync_buf.txt");
  }

  private contextTokensPath(): string {
    return join(this.statePath(), "context_tokens.json");
  }

  private async loadContextTokens(): Promise<Map<string, string>> {
    const raw = await readTextFile(this.contextTokensPath());
    if (!raw) return new Map();
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      const entries = Object.entries(parsed).filter(([, value]) => typeof value === "string");
      return new Map(entries.slice(-MAX_CONTEXT_TOKENS));
    } catch {
      return new Map();
    }
  }

  private rememberContextToken(key: string, contextToken: string, typingTarget: string): void {
    this.contextTokens.delete(key);
    this.contextTokens.set(key, contextToken);
    this.typingTargets.delete(key);
    this.typingTargets.set(key, typingTarget);
    this.pruneContextTokens();
  }

  private pruneContextTokens(): void {
    while (this.contextTokens.size > MAX_CONTEXT_TOKENS) {
      const oldestKey = this.contextTokens.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.contextTokens.delete(oldestKey);
      this.typingTargets.delete(oldestKey);
    }
  }

  private async saveContextTokens(): Promise<void> {
    await writeTextFile(
      this.contextTokensPath(),
      JSON.stringify(Object.fromEntries(this.contextTokens), null, 2),
    );
  }
}
