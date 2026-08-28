import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  isAllowedAttachmentUrl,
  MAX_ATTACHMENT_BYTES,
  readAttachmentByteStream,
  nameForAttachment,
  readAttachmentResponseBody,
  safePathSegment,
  saveIncomingAttachmentPayloads,
  saveUrlAttachments,
} from "./attachment-files.js";
import type { Attachment, NormalizedMessage } from "./types.js";

const profileMemoryDir = rs.hoisted(() => ({ value: "" }));

rs.mock("../paths.js", () => ({
  getProfileMemoryDir: () => profileMemoryDir.value,
}));

function messageWithAttachments(attachments: Attachment[]): NormalizedMessage {
  return {
    id: "msg-1",
    channel: "discord",
    channelUserId: "user-1",
    displayName: "User",
    threadId: "thread-1",
    threadType: "private",
    timestamp: new Date("2026-05-10T00:00:00Z"),
    text: "",
    attachments,
    rawEvent: {},
  };
}

describe("attachment URL downloads", () => {
  beforeEach(async () => {
    profileMemoryDir.value = await mkdtemp(join(tmpdir(), "rome-attachments-"));
  });

  afterEach(async () => {
    rs.unstubAllGlobals();
    await rm(profileMemoryDir.value, { recursive: true, force: true });
  });

  it("allows only exact known attachment hosts and paths", () => {
    expect(isAllowedAttachmentUrl("https://cdn.discordapp.com/attachments/1/2/file.png")).toBe(
      true,
    );
    expect(isAllowedAttachmentUrl("https://media.discordapp.net/attachments/1/2/file.png")).toBe(
      true,
    );
    expect(isAllowedAttachmentUrl("https://novac2c.cdn.weixin.qq.com/c2c/file")).toBe(true);
    expect(isAllowedAttachmentUrl("https://mmg.whatsapp.net/file")).toBe(true);
    expect(isAllowedAttachmentUrl("https://api.telegram.org/file/bot123/file")).toBe(true);

    expect(isAllowedAttachmentUrl("http://cdn.discordapp.com/attachments/1/2/file.png")).toBe(
      false,
    );
    expect(isAllowedAttachmentUrl("https://cdn.discordapp.com.evil/attachments/1/2/file.png")).toBe(
      false,
    );
    expect(isAllowedAttachmentUrl("https://cdn.discordapp.com/avatar/1/file.png")).toBe(false);
    expect(
      isAllowedAttachmentUrl("https://user:pass@cdn.discordapp.com/attachments/1/2/file.png"),
    ).toBe(false);
    expect(isAllowedAttachmentUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedAttachmentUrl("http://localhost:8080/file")).toBe(false);
  });

  it("downloads allowed URLs", async () => {
    const body = Buffer.from("image-data");
    const fetchMock = rs.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    rs.stubGlobal("fetch", fetchMock);

    const attachments = await saveUrlAttachments(
      messageWithAttachments([
        {
          type: "image",
          url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
          fileName: "photo.png",
        },
      ]),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(attachments[0].mimeType).toBe("image/png");
    expect(attachments[0].localPath).toBeTruthy();
    await expect(readFile(attachments[0].localPath!)).resolves.toEqual(body);
  });

  it("skips untrusted attachment URLs before fetching", async () => {
    const fetchMock = rs.fn();
    rs.stubGlobal("fetch", fetchMock);

    const originalAttachment: Attachment = {
      type: "document",
      url: "http://169.254.169.254/latest/meta-data/",
    };
    const attachments = await saveUrlAttachments(messageWithAttachments([originalAttachment]));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(attachments).toEqual([originalAttachment]);
  });

  it("keeps successful URL downloads when another attachment fails", async () => {
    const fetchMock = rs.fn(async (url: string) => {
      if (url.includes("too-large")) {
        return new Response("small placeholder", {
          status: 200,
          headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) },
        });
      }
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    rs.stubGlobal("fetch", fetchMock);

    const attachments = await saveUrlAttachments(
      messageWithAttachments([
        {
          type: "document",
          url: "https://cdn.discordapp.com/attachments/1/2/too-large.pdf",
          fileName: "too-large.pdf",
        },
        {
          type: "image",
          url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
          fileName: "photo.png",
        },
      ]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attachments[0].localPath).toBeUndefined();
    expect(attachments[1].localPath).toBeTruthy();
    await expect(readFile(attachments[1].localPath!)).resolves.toEqual(Buffer.from("ok"));
  });

  it("rejects response bodies larger than the streaming limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    await expect(readAttachmentResponseBody(new Response(stream), 5)).rejects.toThrow(
      "attachment too large: 6 bytes",
    );
  });

  it("rejects async byte streams larger than the limit", async () => {
    async function* chunks() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5, 6]);
    }

    await expect(readAttachmentByteStream(chunks(), 5)).rejects.toThrow(
      "attachment too large: 6 bytes",
    );
  });
});

describe("attachment file sanitization", () => {
  beforeEach(async () => {
    profileMemoryDir.value = await mkdtemp(join(tmpdir(), "rome-attachments-"));
  });

  afterEach(async () => {
    await rm(profileMemoryDir.value, { recursive: true, force: true });
  });

  it("sanitizes path segments without stripping useful unicode", () => {
    expect(safePathSegment("hello world")).toBe("hello-world");
    expect(safePathSegment("../secret")).toBe("..-secret");
    expect(safePathSegment("..")).toBe("unknown");
    expect(safePathSegment("画像 report")).toBe("画像-report");
    expect(Buffer.byteLength(safePathSegment("a".repeat(300)))).toBeLessThanOrEqual(180);
  });

  it("builds safe attachment names for empty, traversal, and missing-mime inputs", () => {
    expect(nameForAttachment({ type: "image", fileName: "" }, 0)).toBe("attachment-1-image.jpg");
    expect(
      nameForAttachment({ type: "document", fileName: "../report" }, 0, "application/pdf"),
    ).toBe("report.pdf");
    expect(nameForAttachment({ type: "document" }, 1)).toBe("attachment-2-document.bin");
  });

  it("saves sanitized filenames under the message attachment directory", async () => {
    const duplicateA: Attachment = {
      type: "document",
      fileName: "../report.pdf",
      mimeType: "application/pdf",
    };
    const duplicateB: Attachment = {
      type: "document",
      fileName: "report.pdf",
      mimeType: "application/pdf",
    };
    const generated: Attachment = { type: "image" };
    const unicode: Attachment = {
      type: "document",
      fileName: "画像 report",
      mimeType: "application/pdf",
    };
    const longName: Attachment = {
      type: "image",
      fileName: `${"a".repeat(300)}.png`,
    };
    const message = messageWithAttachments([duplicateA, duplicateB, generated, unicode, longName]);
    message.threadId = "thread/../../secret";
    message.id = "..";

    const attachments = await saveIncomingAttachmentPayloads(message, [
      { attachment: duplicateA, data: Buffer.from("a") },
      { attachment: duplicateB, data: Buffer.from("b") },
      { attachment: generated, data: Buffer.from("c") },
      { attachment: unicode, data: Buffer.from("d") },
      { attachment: longName, data: Buffer.from("e") },
    ]);

    const localPaths = attachments.map((attachment) => attachment.localPath);
    expect(localPaths).toHaveLength(5);
    expect(localPaths.every(Boolean)).toBe(true);
    expect(basename(localPaths[0]!)).toBe("report.pdf");
    expect(basename(localPaths[1]!)).toBe("report-2.pdf");
    expect(basename(localPaths[2]!)).toBe("attachment-3-image.jpg");
    expect(basename(localPaths[3]!)).toBe("画像-report.pdf");
    expect(Buffer.byteLength(basename(localPaths[4]!))).toBeLessThanOrEqual(184);
    expect(basename(localPaths[4]!).endsWith(".png")).toBe(true);

    for (const localPath of localPaths) {
      expect(relative(profileMemoryDir.value, localPath!)).not.toMatch(/^\.\./);
      expect(dirname(localPath!)).toContain("channel-attachments");
    }
    await expect(readFile(localPaths[0]!)).resolves.toEqual(Buffer.from("a"));
    await expect(readFile(localPaths[1]!)).resolves.toEqual(Buffer.from("b"));
  });
});
