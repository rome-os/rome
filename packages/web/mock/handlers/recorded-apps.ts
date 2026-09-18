import type { InstalledAppCard } from "@rome/api-types/apps";
import { http, HttpResponse } from "msw";
import reviews from "../fixtures/code-reviews.json";
import fitness from "../fixtures/fitness-tracker.json";
import triage from "../fixtures/issue-triage.json";
import reviewRepository from "../fixtures/review-repository.json";
import stocks from "../fixtures/stock-daily.json";
import video from "../fixtures/youtube-distill.json";

const definitions = [
  {
    id: "yt-distill",
    displayName: "YouTube Distill",
    version: "0.4.0",
    description: "Turn a YouTube video into a mind map, key-point summary, and slide deck.",
    entry: "index",
  },
  {
    id: "code-review",
    displayName: "Code Review",
    version: "0.30.2",
    description: "Review pull requests with severity-ranked findings and a clear verdict.",
    entry: "66",
  },
  {
    id: "issue-triage",
    displayName: "Issue Triage",
    version: "0.2.2",
    description: "Classify GitHub issues with labels, priorities, and clear reasoning.",
    entry: "index",
  },
  {
    id: "fitness-tracker",
    displayName: "Fitness Tracker",
    version: "0.2.0",
    description: "Follow a weekly workout plan with five-minute video modules.",
    entry: "index",
  },
  {
    id: "stock-daily",
    displayName: "Stock Daily",
    version: "0.6.0",
    description: "Read daily market reports with index summaries, analysis, and sources.",
    entry: "index",
  },
];

export const recordedApps: InstalledAppCard[] = definitions.map((app) => ({
  id: app.id,
  displayName: app.displayName,
  description: app.description,
  version: app.version,
  status: "active",
  phase: "installed",
  hasFrontend: true,
  href: `/apps/${app.id}`,
  fullHref: `/full/apps/${app.id}`,
  capabilities: [],
  capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
  isEnabled: true,
  canToggle: true,
  canUninstall: true,
  canPublish: false,
  accessMode: "private",
  isPublic: false,
  cloudAllowedEmails: [],
  canManagePublicAccess: true,
  source: { mode: "appstore", listingId: app.id, version: app.version },
  projectPath: null,
  origin: "appstore",
  iconUrl: `/recorded-apps/${app.id}/icon.svg`,
}));

const activity = reviews.map((review) => ({
  kind: "review",
  type: "review",
  tag: "Review",
  id: review.id,
  repo: review.repo,
  surface: "pr",
  number: review.prNumber,
  title: review.prTitle,
  intent: null,
  status: review.status,
  actor: review.prAuthor,
  url: review.prUrl,
  resultUrl: review.githubCommentUrl,
  hasSession: false,
  createdAt: review.startedAt,
  completedAt: review.completedAt,
}));
const counts = {
  all: reviews.length,
  review: reviews.length,
  question: 0,
  memory: 0,
  "code-task": 0,
};
const missing = () =>
  HttpResponse.json({ error: "This item is not included in the demo." }, { status: 404 });

// These bundles use the real app host. Keep their unrecorded API calls local,
// including writes, when mock mode runs with a backend proxy.
export const recordedAppHandlers = [
  ...definitions.map((app) =>
    http.get(`/api/apps/${app.id}/manifest`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      const mode = query.get("mode") === "full" ? "full" : "embedded";
      const assetBase = `/recorded-apps/${app.id}`;
      return HttpResponse.json({
        appId: app.id,
        appName: app.displayName,
        accessMode: "private",
        callerAccessAllowed: true,
        entryUrl: `${assetBase}/${app.entry}.js`,
        styleUrls: [`${assetBase}/${app.entry}.css`],
        bootstrap: {
          appId: app.id,
          version: app.version,
          routeBase: `${mode === "full" ? "/full" : ""}/apps/${app.id}`,
          routePath: query.get("path") ?? "",
          apiBase: `/api/apps/${app.id}`,
          assetBase,
          shell: { theme: "light", themeName: "slate", locale: "en", mode },
          caller: { kind: "guardian", userId: "mock-guardian" },
          globalParams: {},
        },
      });
    }),
  ),
  http.get("/api/apps/yt-distill/list", () =>
    HttpResponse.json({
      items: [{ ...video, artifacts: { mindmap: true, summary: true, slides: true } }],
    }),
  ),
  http.get("/api/apps/yt-distill/item/:id", ({ params }) =>
    params.id === video.id ? HttpResponse.json(video) : missing(),
  ),
  http.get("/api/apps/code-review/dashboard", () =>
    HttpResponse.json({
      repositories: [reviewRepository.repository],
      recentPRReviews: reviews,
      prReviewSettings: [reviewRepository.settings],
      recentMentionTasks: [],
      repoStats: {
        "rome-os/rome": {
          reviewCount: reviews.length,
          lastActivityAt: reviews[0].startedAt,
          trend: [0, 0, 0, 0, 0, 0, reviews.length],
        },
      },
      activityCounts: counts,
      stats: { totalRepos: 1, totalPRReviews: reviews.length },
    }),
  ),
  http.get("/api/apps/code-review/activity", ({ request }) => {
    const query = new URL(request.url).searchParams;
    const type = query.get("type") ?? "all";
    const filtered = type === "all" || type === "review" ? activity : [];
    const limit = Math.max(1, Math.min(20, Number(query.get("limit")) || 20));
    const offset = Math.max(0, Number(query.get("offset")) || 0);
    return HttpResponse.json({
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      counts,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
    });
  }),
  http.get("/api/apps/code-review/pr-reviews/:id", ({ params }) => {
    const review = reviews.find((item) => item.id === params.id);
    return review ? HttpResponse.json({ review }) : missing();
  }),
  http.get("/api/apps/code-review/gh-auth-status", () =>
    HttpResponse.json({ loggedIn: true, login: "rome-demo" }),
  ),
  http.get("/api/apps/code-review/github-users/:login", ({ params }) =>
    HttpResponse.json({
      login: String(params.login),
      name: String(params.login),
      avatarUrl: "/recorded-apps/code-review/icon.svg",
      htmlUrl: null,
    }),
  ),
  http.get("/api/apps/code-review/project-memory", () =>
    HttpResponse.json({ projectMemory: null, edits: [] }),
  ),
  http.get("/api/apps/issue-triage/dashboard", () => HttpResponse.json(triage)),
  http.get("/api/apps/issue-triage/gh-auth-status", () =>
    HttpResponse.json({ loggedIn: true, login: "rome-demo" }),
  ),
  http.get("/api/apps/issue-triage/repositories", () =>
    HttpResponse.json({ repositories: triage.repositories }),
  ),
  http.get("/api/apps/issue-triage/repo-settings", ({ request }) => {
    const repo = new URL(request.url).searchParams.get("repo");
    const settings = triage.repoSettings.find((item) => item.repo === repo);
    return settings ? HttpResponse.json({ settings }) : missing();
  }),
  http.get("/api/apps/issue-triage/triage-results", ({ request }) => {
    const query = new URL(request.url).searchParams;
    const repo = query.get("repo");
    const results = triage.recentResults.filter((item) => !repo || item.repo === repo);
    const limit = Math.max(1, Math.min(50, Number(query.get("limit")) || 50));
    const offset = Math.max(0, Number(query.get("offset")) || 0);
    return HttpResponse.json({
      results: results.slice(offset, offset + limit),
      total: results.length,
      limit,
      offset,
      hasMore: offset + limit < results.length,
    });
  }),
  http.get("/api/apps/issue-triage/triage-results/:id", ({ params }) => {
    const result = triage.recentResults.find((item) => item.id === params.id);
    return result ? HttpResponse.json({ result }) : missing();
  }),
  http.get("/api/apps/fitness-tracker/state", () => HttpResponse.json(fitness)),
  http.get("/api/apps/stock-daily/dashboard", () => HttpResponse.json(stocks)),
  http.get("/api/apps/stock-daily/reports/:id", ({ params }) => {
    const report = stocks.reports.find((item) => item.id === params.id);
    return report ? HttpResponse.json({ report }) : missing();
  }),
  http.all(
    /\/api\/apps\/(yt-distill|code-review|issue-triage|fitness-tracker|stock-daily)\/.+/,
    ({ request }) =>
      request.method === "GET"
        ? missing()
        : HttpResponse.json(
            { error: "This demo contains recorded results. Run this action in your own Rome." },
            { status: 409 },
          ),
  ),
];
