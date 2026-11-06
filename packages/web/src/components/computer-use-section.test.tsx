// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComputerUseStatus } from "@rome/api-types/computer-use";
import i18n from "@/i18n";
import { ComputerUseSection } from "./computer-use-section";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function mount(body: ComputerUseStatus, httpStatus = 200) {
  rs.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status: httpStatus }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ComputerUseSection />
    </QueryClientProvider>,
  );
}

const status: ComputerUseStatus = {
  daemon: { status: "running", version: "1.8.8" },
  checkedAt: "2026-09-13T09:00:00.000Z",
  connections: [
    {
      id: "rome-id",
      name: "Rome browser",
      cli: "opencli",
      status: "connected",
      version: "1.0.24",
      lastSeenAt: "2026-09-13T08:59:50.000Z",
    },
    {
      id: "mac-id",
      name: "Mac Chrome",
      cli: "opencli",
      status: "disconnected",
      version: "1.0.24",
      lastSeenAt: "2026-09-13T07:00:00.000Z",
    },
  ],
};

async function openDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
}

describe("ComputerUseSection", () => {
  it("summarizes the daemon and connected browsers in one row", async () => {
    mount(status);
    expect(await screen.findByText("1 browser connected")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Rome browser")).toBeNull();
  });

  it("shows live and disconnected browsers with the exact last seen time available", async () => {
    mount(status);
    await openDetails();
    expect(await screen.findByText("Rome browser")).toBeTruthy();
    expect(screen.getByText("Mac Chrome")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(document.querySelector('time[datetime="2026-09-13T07:00:00.000Z"]')).not.toBeNull();
  });

  it("keeps known browsers visible when the daemon is unavailable", async () => {
    mount({
      ...status,
      daemon: { status: "unavailable", version: null },
      connections: status.connections.map((c) => ({ ...c, status: "unknown" })),
    });
    expect(await screen.findByText(/OpenCLI is unreachable/)).toBeTruthy();
    await openDetails();
    expect(await screen.findByText("Mac Chrome")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("distinguishes an empty connection list from a failed request", async () => {
    mount({ ...status, connections: [] });
    await openDetails();
    expect(await screen.findByText(/No browser connections have been observed/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Install OpenCLI extension" }).getAttribute("href"),
    ).toContain("ildkmabpimmkaediidaifkhjpohdnifk");
    cleanup();
    rs.restoreAllMocks();
    mount(status, 503);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await openDetails();
    expect(screen.queryByText(/No browser connections have been observed/)).toBeNull();
  });
});
