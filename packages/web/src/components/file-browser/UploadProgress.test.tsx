// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { UploadProgress } from "./UploadProgress";
import type { FileUploadProgress } from "./store/types";

const progress: FileUploadProgress = {
  fileCount: 3,
  firstFileName: "project-assets.zip",
  loaded: 12.4 * 1024 ** 2,
  total: 48 * 1024 ** 2,
  phase: "uploading",
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

describe("UploadProgress", () => {
  it("shows file count, real percentage, byte totals, and the keep-open warning", () => {
    render(<UploadProgress progress={progress} />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Uploading 3 files")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("12.4 MB of 48.0 MB")).toBeTruthy();
    expect(screen.getByText("Keep this page open until the upload finishes.")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Uploading 3 files" });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("25%");
  });

  it("truncates the single filename while keeping its full accessible name", () => {
    const title = "project-assets.zip";
    render(<UploadProgress progress={{ ...progress, fileCount: 1 }} />);
    expect(screen.getByText(title).classList.contains("truncate")).toBe(true);
    expect(screen.getByText(title).getAttribute("title")).toBe(title);
    expect(screen.getByRole("progressbar", { name: `Uploading ${title}` })).toBeTruthy();
  });

  it("omits a fabricated percentage for unknown totals", () => {
    render(<UploadProgress progress={{ ...progress, total: 0 }} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(bar.firstElementChild?.classList.contains("motion-safe:animate-pulse")).toBe(true);
  });

  it("shows finishing rather than silently sitting at 100%", () => {
    render(
      <UploadProgress progress={{ ...progress, loaded: progress.total, phase: "finishing" }} />,
    );
    expect(screen.getByText("Finishing…")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("Finishing…");
  });

  it("localizes the title, finishing state, byte line, and warning in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<UploadProgress progress={{ ...progress, phase: "finishing" }} />);
    expect(screen.getByText("正在上传 3 个文件")).toBeTruthy();
    expect(screen.getByText("正在处理…")).toBeTruthy();
    expect(screen.getByText("12.4 MB / 48.0 MB")).toBeTruthy();
    expect(screen.getByText("上传完成前请不要离开或关闭此页面")).toBeTruthy();
  });
});
