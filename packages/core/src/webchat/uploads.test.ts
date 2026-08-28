import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendUploadPathsToPrompt, saveWebchatUploads } from "./uploads.js";

describe("webchat upload helpers", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("saves uploads in the project directory with collision-safe names", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "rome-webchat-upload-"));
    const workingDir = join(projectsRoot, "alpha");
    tempDirs.push(projectsRoot);
    const now = new Date(2026, 4, 18);

    const saved = await saveWebchatUploads(
      workingDir,
      projectsRoot,
      [
        { name: "../report.txt", data: Buffer.from("first"), mimeType: "text/plain" },
        { name: "report.txt", data: Buffer.from("second"), mimeType: "text/plain" },
      ],
      now,
    );

    expect(saved).toEqual([
      expect.objectContaining({
        name: "report.txt",
        relativePath: "2026/05/18/report.txt",
        linkPath: "/projects/alpha/2026/05/18/report.txt",
        path: join(workingDir, "2026", "05", "18", "report.txt"),
        size: 5,
      }),
      expect.objectContaining({
        name: "report-2.txt",
        relativePath: "2026/05/18/report-2.txt",
        linkPath: "/projects/alpha/2026/05/18/report-2.txt",
        path: join(workingDir, "2026", "05", "18", "report-2.txt"),
        size: 6,
      }),
    ]);
    expect(readFileSync(saved[0].path, "utf-8")).toBe("first");
    expect(readFileSync(saved[1].path, "utf-8")).toBe("second");
  });

  it("appends saved upload paths to an existing prompt", () => {
    expect(
      appendUploadPathsToPrompt("Please inspect these files.", [
        {
          relativePath: "2026/05/18/report.txt",
          linkPath: "/projects/alpha/2026/05/18/report.txt",
        },
        {
          relativePath: "2026/05/18/spec.md",
          linkPath: "/projects/alpha/2026/05/18/spec.md",
        },
      ]),
    ).toBe(
      "Please inspect these files.\n\n- File 1: [report.txt](</projects/alpha/2026/05/18/report.txt>)\n- File 2: [spec.md](</projects/alpha/2026/05/18/spec.md>)",
    );
  });

  it("escapes markdown delimiters in uploaded file links", () => {
    expect(
      appendUploadPathsToPrompt("", [
        {
          relativePath: "2026/05/18/design-(final).md",
          linkPath: "/projects/alpha/2026/05/18/design-(final).md",
        },
        {
          relativePath: "2026/05/18/x](bad)[draft].txt",
          linkPath: "/projects/alpha/2026/05/18/x](bad)[draft].txt",
        },
      ]),
    ).toBe(
      "- File 1: [design-(final).md](</projects/alpha/2026/05/18/design-%28final%29.md>)\n- File 2: [x\\](bad)\\[draft\\].txt](</projects/alpha/2026/05/18/x%5D%28bad%29%5Bdraft%5D.txt>)",
    );
  });

  it("builds a prompt from uploads when the message body is empty", () => {
    expect(
      appendUploadPathsToPrompt("", [
        {
          relativePath: "2026/05/18/report.txt",
          linkPath: "/projects/alpha/2026/05/18/report.txt",
        },
      ]),
    ).toBe("- File 1: [report.txt](</projects/alpha/2026/05/18/report.txt>)");
  });
});
