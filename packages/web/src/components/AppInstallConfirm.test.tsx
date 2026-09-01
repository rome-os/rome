// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { AppInstallConfirm } from "./AppInstallConfirm";
import type { ListingDetailPayload } from "./AppInstallConfirm";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function listingPayload(overrides?: {
  iconUrl?: string | null;
  iconPath?: string | null;
}): ListingDetailPayload {
  return {
    available: true,
    browseOrigin: "https://store.example",
    listing: {
      id: "customer-service",
      handle: "rome",
      slug: "customer-service",
      name: "Customer Service",
      description: "Grounded customer-service agent.",
      longDescription: null,
      iconUrl: overrides?.iconUrl ?? null,
      iconPath: overrides?.iconPath ?? null,
      categories: [],
      state: "published",
      highestVersion: "0.1.19",
      verified: true,
    },
    versions: [
      {
        version: "0.1.19",
        contentHash: "fd198ce2076a582d",
        sizeBytes: 598_700,
        state: "live",
        publishedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  };
}

function mockListingFetch(payload: ListingDetailPayload) {
  rs.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => structuredClone(payload),
  } as Response);
}

function renderConfirm() {
  return render(
    <AppInstallConfirm
      listingId="customer-service"
      requestedVersion={null}
      onInstalled={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe("AppInstallConfirm", () => {
  it("renders the listing's iconUrl in the header", async () => {
    mockListingFetch(listingPayload({ iconUrl: "https://cdn.example/icons/customer-service.png" }));
    const { container } = renderConfirm();

    await screen.findByText("Install this app?");
    const icon = container.querySelector("img");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("src")).toBe("https://cdn.example/icons/customer-service.png");
  });

  it("resolves a relative legacy iconPath against browseOrigin", async () => {
    mockListingFetch(listingPayload({ iconPath: "/icons/customer-service.png" }));
    const { container } = renderConfirm();

    await screen.findByText("Install this app?");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://store.example/icons/customer-service.png",
    );
  });

  it("falls back to a letter avatar when the listing has no icon", async () => {
    mockListingFetch(listingPayload());
    const { container } = renderConfirm();

    await screen.findByText("Install this app?");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("C")).toBeTruthy();
  });

  it("keeps one accessible button name while installation is pending", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      if (String(input) === "/api/apps") return new Promise(() => {});
      return Response.json(listingPayload());
    }) as typeof fetch);
    renderConfirm();

    fireEvent.click(await screen.findByRole("button", { name: "Install v0.1.19" }));

    expect(await screen.findByRole("status", { name: "Installing..." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Installing..." })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Installing... Installing..." })).toBeNull();
  });
});
