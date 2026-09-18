// @rstest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { setupServer } from "msw/node";
import { recordedAppHandlers } from "../../../mock/handlers/recorded-apps";

const server = setupServer(...recordedAppHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

describe("recorded app demo", () => {
  it("keeps full-view routes and assets on the local demo origin", async () => {
    const response = await fetch("/api/apps/yt-distill/manifest?mode=full&path=llm-deep-dive");
    expect(await response.json()).toMatchObject({
      entryUrl: "/recorded-apps/yt-distill/index.js",
      bootstrap: {
        routeBase: "/full/apps/yt-distill",
        routePath: "llm-deep-dive",
        apiBase: "/api/apps/yt-distill",
        caller: { kind: "guardian", userId: "mock-guardian" },
      },
    });
  });

  it("opens every listed review and keeps the subset counts consistent", async () => {
    const page = await (await fetch("/api/apps/code-review/activity?type=review&limit=1")).json();
    expect(page).toMatchObject({ total: 2, counts: { all: 2, review: 2 }, hasMore: true });
    const next = await (
      await fetch("/api/apps/code-review/activity?type=review&limit=1&offset=1")
    ).json();
    expect(next).toMatchObject({ total: 2, hasMore: false });
    for (const item of [...page.items, ...next.items]) {
      const detail = await (await fetch(`/api/apps/code-review/pr-reviews/${item.id}`)).json();
      expect(detail.review).toMatchObject({ id: item.id, status: "completed", romeSession: null });
      expect(detail.review.reviewComment.length).toBeGreaterThan(100);
    }
    const empty = await (await fetch("/api/apps/code-review/activity?type=question")).json();
    expect(empty).toMatchObject({ items: [], total: 0, hasMore: false });
  });

  it("contains one complete video result and a bounded transcript excerpt", async () => {
    const list = await (await fetch("/api/apps/yt-distill/list")).json();
    expect(list.items).toHaveLength(1);
    const detail = await (await fetch(`/api/apps/yt-distill/item/${list.items[0].id}`)).json();
    expect(detail).toMatchObject({ status: "ready", title: "Deep Dive into LLMs like ChatGPT" });
    expect(detail.summaryMd).toContain("Pre-training");
    expect(detail.mindmapMd).toContain("LLMs");
    expect(detail.slidesHtml).toContain("<html");
    expect(detail.transcript).toContain("Transcript excerpt");
    expect(detail.transcript.length).toBeLessThan(1600);
  });

  it("opens each selected triage result and filters the repository history", async () => {
    const dashboard = await (await fetch("/api/apps/issue-triage/dashboard")).json();
    expect(dashboard.stats).toMatchObject({ totalTriaged: 3, succeeded: 3, failed: 0 });
    expect(dashboard.recentResults).toHaveLength(3);
    for (const item of dashboard.recentResults) {
      const detail = await (await fetch(`/api/apps/issue-triage/triage-results/${item.id}`)).json();
      expect(detail.result).toMatchObject({ id: item.id, status: "succeeded", romeSession: null });
      expect(detail.result.reasoning.length).toBeGreaterThan(100);
    }
    const history = await (
      await fetch("/api/apps/issue-triage/triage-results?repo=rome-os%2Frome&limit=2&offset=2")
    ).json();
    expect(history).toMatchObject({ total: 3, hasMore: false });
    expect(history.results).toHaveLength(1);
    const empty = await (await fetch("/api/apps/issue-triage/triage-results?repo=missing")).json();
    expect(empty).toMatchObject({ results: [], total: 0 });
  });

  it("includes every exercise referenced by the weekly fitness plan", async () => {
    const state = await (await fetch("/api/apps/fitness-tracker/state")).json();
    expect(state.plan).toHaveLength(7);
    expect(state.exercises).toHaveLength(14);
    for (const day of state.plan) {
      const modules = day.moduleIds.map((id: string) =>
        state.exercises.find((exercise: { id: string }) => exercise.id === id),
      );
      expect(modules.every(Boolean)).toBe(true);
      expect(
        modules.reduce(
          (sum: number, exercise: { durationMin: number }) => sum + exercise.durationMin,
          0,
        ),
      ).toBe(day.totalMinutes);
    }
    expect(JSON.stringify(state)).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("opens both complete market reports without advertising omitted PDFs", async () => {
    const dashboard = await (await fetch("/api/apps/stock-daily/dashboard?limit=50")).json();
    expect(dashboard.reports).toHaveLength(2);
    expect(dashboard.activeSchedule.emailRecipient).toBe("guardian@example.com");
    for (const item of dashboard.reports) {
      const detail = await (await fetch(`/api/apps/stock-daily/reports/${item.id}`)).json();
      expect(detail.report).toMatchObject({
        id: item.id,
        status: "completed",
        pdfAvailable: false,
      });
      expect(detail.report.content.length).toBeGreaterThan(10000);
      expect(detail.report.sources.length).toBeGreaterThan(5);
    }
    expect(JSON.stringify(dashboard)).not.toContain("ray.romeos.cc");
  });

  it("refuses unrecorded reads and writes without reaching a backend", async () => {
    expect((await fetch("/api/apps/code-review/pr-reviews/missing")).status).toBe(404);
    for (const [path, method] of [
      ["/api/apps/code-review/pr-reviews", "POST"],
      ["/api/apps/code-review/pr-reviews/review-301/rereview", "POST"],
      ["/api/apps/yt-distill/item/llm-deep-dive", "DELETE"],
      ["/api/apps/yt-distill/generate", "POST"],
      ["/api/apps/issue-triage/repo-settings", "POST"],
      ["/api/apps/fitness-tracker/logs", "POST"],
      ["/api/apps/stock-daily/generate", "POST"],
    ]) {
      const response = await fetch(path, { method });
      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty("error");
    }
  });
});
