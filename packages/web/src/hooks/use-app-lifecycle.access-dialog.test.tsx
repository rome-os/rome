// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstalledAppCard } from "@rome/api-types/apps";
import i18n from "@/i18n";
import { useAppLifecycle } from "./use-app-lifecycle";

// jsdom serves the page on localhost, which the dialog treats as unshareable.
const origin = rs.hoisted(() => ({ value: "https://jessie.romeos.cc" as string | null }));
rs.mock("@/lib/shareable-origin", () => ({ shareableOrigin: () => origin.value }));

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

const APP: InstalledAppCard = {
  id: "@ray/demo",
  version: "1.2.0",
  description: "",
  displayName: "Demo",
  status: "active",
  phase: "installed",
  hasFrontend: true,
  href: "/apps/@ray/demo",
  fullHref: "/full/apps/%40ray%2Fdemo",
  capabilities: [],
  capabilityDetails: { agents: [], actions: [], skills: [], hooks: [] },
  isEnabled: true,
  canToggle: true,
  canUninstall: true,
  canPublish: true,
  accessMode: "private",
  isPublic: false,
  cloudAllowedEmails: [],
  canManagePublicAccess: true,
} as unknown as InstalledAppCard;

/** Opens the access dialog on mount and renders it, the way a page does. */
function Harness({ app = APP }: { app?: InstalledAppCard }) {
  const lifecycle = useAppLifecycle([app], { probeUpdates: false });
  return (
    <>
      <button type="button" onClick={() => lifecycle.requestAccess(app)}>
        open
      </button>
      {lifecycle.dialogs}
    </>
  );
}

async function openDialog(app: InstalledAppCard = APP) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Harness app={app} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "open" }));
  return screen.findByRole("radiogroup");
}

describe("the app access dialog", () => {
  it("offers the three access modes as one radiogroup", async () => {
    const group = await openDialog();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const radio of radios) {
      expect(group.contains(radio)).toBe(true);
    }
    // A group with no accessible name is unusable by screen reader, and the
    // role promises arrow-key movement that a row of buttons does not give.
    expect(group.getAttribute("aria-label")).toBeTruthy();
  });

  it("checks exactly the app's current mode", async () => {
    await openDialog();

    const checked = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]?.getAttribute("value")).toBe("private");
  });

  it("moves the selection with the arrow keys, which the old buttons never did", async () => {
    await openDialog();

    const radios = screen.getAllByRole("radio");
    const [first, second] = radios;
    first?.focus();

    fireEvent.keyDown(first as HTMLElement, { key: "ArrowDown" });

    // Radix moves focus on a later tick and checks the option on arrival. Three
    // `<button role="radio">` were three tab stops that answered no arrow key.
    await waitFor(() => expect(document.activeElement).toBe(second));
    expect(second?.getAttribute("aria-checked")).toBe("true");
    expect(first?.getAttribute("aria-checked")).toBe("false");
  });

  it("reveals the email list only while the cloud mode is the checked one", async () => {
    await openDialog();

    const emailLabel = i18n.t("installed.accessDialog.emailLabel", { ns: "apps" });
    expect(screen.queryByLabelText(emailLabel)).toBeNull();

    const cloud = screen
      .getAllByRole("radio")
      .find((r) => r.getAttribute("value") === "cloud-email");
    await userEvent.click(cloud as HTMLElement);

    await waitFor(() => {
      expect(screen.getByLabelText(emailLabel)).not.toBeNull();
    });
  });

  // The highlight is derived from the radio rather than tracked beside it, so
  // the card that looks chosen and the option that is chosen cannot disagree.
  it("hangs the card's paint on the radio's own state", async () => {
    await openDialog();

    const radio = screen.getAllByRole("radio")[0] as HTMLElement;
    const card = radio.closest("label");
    expect(card?.className).toContain("has-data-[state=checked]:border-foreground");
    expect(card?.className).toContain("has-focus-visible:outline-ring/50");
  });

  describe("share link", () => {
    const SHARE_URL = "https://jessie.romeos.cc/full/apps/%40ray%2Fdemo";
    const shareLink = () => screen.queryByRole("textbox", { name: "Share link" });
    // jsdom has no Clipboard API, and the copy button shows only where there is one.
    beforeEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async () => {} },
        configurable: true,
      });
    });

    it("is absent while the app is private", async () => {
      await openDialog();
      expect(shareLink()).toBeNull();
    });

    it("shows the link for a newly picked mode, but holds copy until it is saved", async () => {
      await openDialog();
      await userEvent.click(screen.getByRole("radio", { name: /Public/ }));

      expect((shareLink() as HTMLInputElement | null)?.value).toBe(SHARE_URL);
      expect(screen.getByRole("button", { name: "Copy link" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByText("Save access before sharing this link.")).toBeTruthy();
    });

    it("is absent on a loopback host, whose link opens nowhere else", async () => {
      origin.value = null;
      try {
        await openDialog({ ...APP, accessMode: "public", isPublic: true } as InstalledAppCard);
        expect(shareLink()).toBeNull();
      } finally {
        origin.value = "https://jessie.romeos.cc";
      }
    });

    it("copies the link of an app that is already public", async () => {
      const writeText = rs.fn(async (_text: string) => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await openDialog({ ...APP, accessMode: "public", isPublic: true } as InstalledAppCard);

      await userEvent.click(screen.getByRole("button", { name: "Copy link" }));

      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
      expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
      expect(screen.queryByText("Save access before sharing this link.")).toBeNull();
    });

    it("offers no copy button where the browser has no clipboard", async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Harness app={{ ...APP, accessMode: "public", isPublic: true } as InstalledAppCard} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      // Plain http outside loopback is not a secure context: no Clipboard API.
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      fireEvent.click(screen.getByRole("button", { name: "open" }));

      expect((shareLink() as HTMLInputElement | null)?.value).toBe(SHARE_URL);
      expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    });
  });
});
