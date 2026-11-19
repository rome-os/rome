// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReleaseNotesRange } from "@rome/api-types/release-notes";
import i18n from "@/i18n";
import { UpgradeWhatsNew } from "./upgrade-whats-new";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function range(overrides: Partial<ReleaseNotesRange> = {}): ReleaseNotesRange {
  return {
    status: "complete",
    from: "1.1.209",
    to: "1.1.210",
    releases: [
      {
        version: "1.1.210",
        date: "2026-11-19T12:00:00Z",
        url: "https://github.com/rome-os/rome/releases/tag/v1.1.210",
      },
    ],
    coveredFrom: "1.1.209",
    breaking: [],
    new: [{ scope: "connector", text: "add Freshdesk", pr: 2375, version: "1.1.210" }],
    fixes: [{ scope: "ios", text: "keep the reply", pr: 2373, version: "1.1.210" }],
    internal: 0,
    highlights: {
      en: [
        { text: "Connect Freshdesk.", pr: 2375, version: "1.1.210", breaking: false },
        { text: "Replies stay in their thread.", pr: 2373, version: "1.1.210", breaking: false },
      ],
      zh: [
        { text: "可以连接 Freshdesk。", pr: 2375, version: "1.1.210", breaking: false },
        { text: "回复会留在原话题中。", pr: 2373, version: "1.1.210", breaking: false },
      ],
    },
    releaseUrl: "https://github.com/rome-os/rome/releases/tag/v1.1.210",
    compareUrl: "https://github.com/rome-os/rome/compare/v1.1.209...v1.1.210",
    ...overrides,
  };
}

/** Answers each release-notes request from `answer`, keyed by the target. */
function backend(answer: (to: string) => { status: number; body: unknown } | Promise<never>) {
  const requested: string[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://rome.test");
    requested.push(`${url.pathname}${url.search}`);
    const reply = await answer(url.searchParams.get("to") ?? "");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
  return requested;
}

function renderNotes(from: string | null, to: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (f: string | null, t: string) => (
    <QueryClientProvider client={client}>
      <UpgradeWhatsNew key={t} from={f} to={t} />
    </QueryClientProvider>
  );
  const result = render(view(from, to));
  return { ...result, rerenderWith: (f: string | null, t: string) => result.rerender(view(f, t)) };
}

describe("UpgradeWhatsNew", () => {
  it("names one release, with its date and highlights, never the raw entries", async () => {
    const requested = backend(() => ({ status: 200, body: range() }));
    renderNotes("1.1.209", "1.1.210");

    expect(await screen.findByRole("heading", { name: "What's new in 1.1.210" })).toBeTruthy();
    expect(screen.getByText(/^Released /)).toBeTruthy();
    expect(screen.getByText("Connect Freshdesk.")).toBeTruthy();
    expect(screen.getByText("Replies stay in their thread.")).toBeTruthy();
    expect(screen.queryByText(/add Freshdesk/i)).toBeNull();
    expect(screen.queryByText(/keep the reply/i)).toBeNull();
    expect(
      screen.getByRole("link", { name: "See full changes on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/rome-os/rome/releases/tag/v1.1.210");
    expect(requested).toEqual(["/api/system/release-notes?to=1.1.210&from=1.1.209"]);
  });

  it("shows the Chinese highlights in a Chinese UI", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      backend(() => ({ status: 200, body: range() }));
      renderNotes("1.1.209", "1.1.210");
      expect(await screen.findByText("可以连接 Freshdesk。")).toBeTruthy();
      expect(screen.queryByText("Connect Freshdesk.")).toBeNull();
      expect(screen.getByRole("link", { name: "在 GitHub 查看完整变更" })).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("names a range by both ends and its release count, and links the comparison", async () => {
    backend(() => ({
      status: 200,
      body: range({
        from: "1.1.205",
        coveredFrom: "1.1.205",
        releases: [1, 2, 3].map((n) => ({
          version: `1.1.21${n}`,
          date: "2026-11-19T12:00:00Z",
          url: "https://example.test",
        })),
        compareUrl: "https://github.com/rome-os/rome/compare/v1.1.205...v1.1.210",
      }),
    }));
    renderNotes("1.1.205", "1.1.210");

    expect(
      await screen.findByRole("heading", { name: "What's new: 1.1.205 → 1.1.210 (3 releases)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "See full changes on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/rome-os/rome/compare/v1.1.205...v1.1.210");
  });

  it("shows every breaking highlight with its version, and five others until Show all", async () => {
    const many = (prefix: string, n: number, breaking: boolean) =>
      Array.from({ length: n }, (_, i) => ({
        text: `${prefix} ${i + 1}`,
        pr: (breaking ? 100 : 200) + i,
        version: "1.1.210",
        breaking,
      }));
    const en = [...many("Change", 8, false), ...many("Act", 6, true)];
    backend(() => ({
      status: 200,
      body: range({
        releases: [
          { version: "1.1.210", date: "2026-11-19T12:00:00Z", url: "https://example.test" },
          { version: "1.1.209", date: "2026-11-18T12:00:00Z", url: "https://example.test" },
        ],
        highlights: { en, zh: [] },
      }),
    }));
    renderNotes("1.1.208", "1.1.210");
    const user = userEvent.setup();

    expect(await screen.findByText("Breaking changes")).toBeTruthy();
    expect(screen.getAllByText(/^Act \d$/)).toHaveLength(6);
    expect(screen.getAllByText("· 1.1.210").length).toBeGreaterThanOrEqual(6);
    expect(screen.getAllByText(/^Change \d$/)).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Show all 8" }));
    expect(screen.getAllByText(/^Change \d$/)).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
  });

  it("shows only the link to the full changes when no release has highlights", async () => {
    backend(() => ({ status: 200, body: range({ highlights: { en: [], zh: [] } }) }));
    renderNotes("1.1.209", "1.1.210");

    expect(await screen.findByRole("link", { name: "See full changes on GitHub" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/add Freshdesk/i)).toBeNull();
  });

  it("says when the notes cover only part of the upgrade", async () => {
    backend(() => ({
      status: 200,
      body: range({ status: "partial", from: "1.1.180", coveredFrom: "1.1.209" }),
    }));
    renderNotes("1.1.180", "1.1.210");

    expect(
      await screen.findByRole("heading", { name: "What's new: 1.1.209 → 1.1.210 (1 release)" }),
    ).toBeTruthy();
    expect(screen.getByText(/Notes for releases before 1\.1\.209 are not available/)).toBeTruthy();
  });

  it("says the notes cover part of the upgrade when a release does not name its predecessor", async () => {
    backend(() => ({
      status: 200,
      body: range({ status: "partial", from: "1.1.180", coveredFrom: null }),
    }));
    renderNotes("1.1.180", "1.1.210");

    expect(
      await screen.findByRole("heading", { name: "What's new up to 1.1.210 (1 release)" }),
    ).toBeTruthy();
    expect(screen.getByText(/Notes for earlier releases are not available/)).toBeTruthy();
  });

  it("says the notes are missing, or could not load, and links GitHub either way", async () => {
    backend((to) =>
      to === "1.1.210"
        ? { status: 200, body: range({ status: "missing", releases: [], new: [], fixes: [] }) }
        : { status: 502, body: { error: "bad gateway" } },
    );
    const view = renderNotes("1.1.209", "1.1.210");
    expect(await screen.findByText("Release notes for 1.1.210 are not available.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Release notes on GitHub" })).toBeTruthy();
    // Never "no changes" for a release whose notes are not in hand.

    view.rerenderWith("1.1.209", "1.1.211");
    expect(await screen.findByText("Could not load what's new")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Release notes on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/rome-os/rome/releases/tag/v1.1.211",
    );
  });

  it("shows loading, then follows a changed target without the old notes", async () => {
    backend((to) =>
      to === "1.1.211" ? new Promise<never>(() => {}) : { status: 200, body: range() },
    );
    const view = renderNotes("1.1.209", "1.1.210");
    expect(await screen.findByText("Connect Freshdesk.")).toBeTruthy();

    view.rerenderWith("1.1.209", "1.1.211");
    const section = screen.getByRole("heading", { name: "What's new: 1.1.209 → 1.1.211" })
      .parentElement?.parentElement as HTMLElement;
    expect(within(section).getByRole("status", { name: "Loading what's new" })).toBeTruthy();
    expect(screen.queryByText("Connect Freshdesk.")).toBeNull();
  });
});
