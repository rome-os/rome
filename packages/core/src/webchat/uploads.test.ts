import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetTooLargeError } from "../assets/store.js";
import { appendUploadPathsToPrompt, saveWebchatUploads } from "./uploads.js";

const ID = "0123456789abcdef0123456789abcdef";

describe("webchat upload helpers", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rome-webchat-upload-"));
    rs.stubEnv("HOME", home);
    rs.stubEnv("ROME_PROFILE", "upload-test");
  });

  afterEach(() => {
    rs.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("stores each upload as its own asset, even with the same name", async () => {
    const saved = await saveWebchatUploads([
      { name: "image.png", data: Buffer.from("first"), mimeType: "image/png" },
      { name: "image.png", data: Buffer.from("second"), mimeType: "image/png" },
    ]);

    expect(saved).toHaveLength(2);
    expect(saved[0].url).toMatch(/^\/api\/assets\/[0-9a-f]{32}\.png$/);
    expect(saved[1].url).toMatch(/^\/api\/assets\/[0-9a-f]{32}\.png$/);
    expect(saved[0].url).not.toBe(saved[1].url);
    expect(saved[0].path).not.toBe(saved[1].path);
    expect(saved[0].path.startsWith(join(home, ".rome", "upload-test", "assets"))).toBe(true);
    expect(saved.map((upload) => upload.name)).toEqual(["image.png", "image.png"]);
    expect(saved.map((upload) => upload.size)).toEqual([5, 6]);
    expect(readFileSync(saved[0].path, "utf-8")).toBe("first");
    expect(readFileSync(saved[1].path, "utf-8")).toBe("second");
    expect(statSync(saved[0].path).mode & 0o777).toBe(0o444);
  });

  it("labels the link with the sanitized original name and keeps its extension", async () => {
    const [saved] = await saveWebchatUploads([
      { name: "../My Report.PDF", data: Buffer.from("pdf") },
    ]);

    expect(saved.name).toBe("My-Report.PDF");
    expect(saved.url).toMatch(/^\/api\/assets\/[0-9a-f]{32}\.pdf$/);
  });

  it("refuses a file over the cap", async () => {
    await expect(
      saveWebchatUploads([{ name: "big.bin", data: Buffer.alloc(11) }], { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
  });

  it("puts the URL in the persisted text and the local path only in the model's", () => {
    const uploads = [
      {
        name: "report.txt",
        url: `/api/assets/${ID}.txt`,
        path: `/home/rome/.rome/default/assets/${ID}.txt`,
      },
      {
        name: "spec.md",
        url: `/api/assets/${"f".repeat(32)}.md`,
        path: `/data/assets/${"f".repeat(32)}.md`,
      },
    ];

    expect(appendUploadPathsToPrompt("Please inspect these files.", uploads)).toBe(
      `Please inspect these files.\n\n- File 1: [report.txt](</api/assets/${ID}.txt>)\n- File 2: [spec.md](</api/assets/${"f".repeat(32)}.md>)`,
    );
    expect(
      appendUploadPathsToPrompt("Please inspect these files.", uploads, { localPaths: true }),
    ).toBe(
      `Please inspect these files.\n\n- File 1: [report.txt](</api/assets/${ID}.txt>) — local file: /home/rome/.rome/default/assets/${ID}.txt\n- File 2: [spec.md](</api/assets/${"f".repeat(32)}.md>) — local file: /data/assets/${"f".repeat(32)}.md`,
    );
  });

  it("escapes markdown delimiters in the link label", () => {
    expect(
      appendUploadPathsToPrompt("", [
        { name: "design-(final).md", url: `/api/assets/${ID}.md`, path: "/x" },
        { name: "x](bad)[draft].txt", url: `/api/assets/${ID}.txt`, path: "/y" },
      ]),
    ).toBe(
      `- File 1: [design-(final).md](</api/assets/${ID}.md>)\n- File 2: [x\\](bad)\\[draft\\].txt](</api/assets/${ID}.txt>)`,
    );
  });

  it("builds a prompt from uploads when the message body is empty, and leaves text alone without any", () => {
    expect(
      appendUploadPathsToPrompt("", [
        { name: "report.txt", url: `/api/assets/${ID}.txt`, path: "/x" },
      ]),
    ).toBe(`- File 1: [report.txt](</api/assets/${ID}.txt>)`);
    expect(appendUploadPathsToPrompt("  hi  ", [])).toBe("hi");
  });
});
