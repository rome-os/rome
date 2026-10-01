// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import WechatDesktopPage from "./WechatDesktopPage";

let state: Record<string, unknown> = { state: "absent" };
const posts: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/wechat/app") return json(state);
  if (init?.method === "POST" && url === "/api/wechat/app/install") {
    posts.push(url);
    state = { state: "installing" };
    return json(state, 202);
  }
  if (init?.method === "POST" && url === "/api/wechat/app/start") {
    posts.push(url);
    state = { state: "starting" };
    return json(state, 202);
  }
  return new Response(null, { status: 404 });
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WechatDesktopPage />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  state = { state: "absent" };
  posts.length = 0;
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("WechatDesktopPage", () => {
  it("offers to install WeChat when it is not installed, and shows the download", async () => {
    renderPage();
    expect(await screen.findByText("WeChat is not installed")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Install WeChat" }));

    expect(posts).toEqual(["/api/wechat/app/install"]);
    expect(await screen.findByText("Installing WeChat")).toBeTruthy();
    expect(screen.queryByTitle("Rome desktop “wechat”")).toBeNull();
  });

  it("offers to start an installed client that is not running", async () => {
    state = { state: "stopped" };
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Start WeChat" }));
    expect(posts).toEqual(["/api/wechat/app/start"]);
    expect(await screen.findByText("Starting WeChat")).toBeTruthy();
  });

  it("shows why the last install failed, with a retry", async () => {
    state = { state: "absent", error: "Could not download the WeChat client: 503" };
    renderPage();
    expect(
      await screen.findByText(
        "The install did not finish: Could not download the WeChat client: 503",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(posts).toEqual(["/api/wechat/app/install"]);
  });

  it("shows WeChat's desktop once the client runs", async () => {
    state = { state: "running" };
    renderPage();
    await waitFor(() => expect(screen.getByTitle("Rome desktop “wechat”")).toBeTruthy());
  });

  it("says when WeChat is not enabled on this instance", async () => {
    state = { state: "unavailable" };
    renderPage();
    expect(await screen.findByText("WeChat is not enabled")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
