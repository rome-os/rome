import { cleanup, render, waitFor } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { toast } from "sonner";
import { Toaster } from "./sonner.js";
import { mountShadowApp } from "./test/shadow-app.js";

// Compile-only regression coverage for the wrapper's narrower public contract.
function paintedModePropsAreRejected() {
  return (
    <>
      {/* @ts-expect-error Rome follows the host theme instead of Sonner's painted theme. */}
      <Toaster theme="dark" />
      {/* @ts-expect-error Rome does not expose Sonner's painted rich-color mode. */}
      <Toaster richColors />
    </>
  );
}
void paintedModePropsAreRejected;

afterEach(() => {
  toast.dismiss();
  cleanup();
  document.body.innerHTML = "";
});

describe("Toaster", () => {
  it("renders token-painted toasts inside an app shadow root", async () => {
    const { appBody, mountRoot } = mountShadowApp();

    render(<Toaster position="top-right" closeButton />, { container: mountRoot });
    toast("App installed", {
      description: "The app is ready to open.",
      action: { label: "Undo", onClick: () => {} },
      cancel: { label: "Cancel", onClick: () => {} },
    });

    await waitFor(() => {
      expect(mountRoot.querySelector("[data-sonner-toast]")).not.toBeNull();
    });

    const toaster = mountRoot.querySelector("[data-sonner-toaster]");
    const renderedToast = mountRoot.querySelector("[data-sonner-toast]");
    const description = renderedToast?.querySelector("[data-description]");
    const action = renderedToast?.querySelector("[data-button]:not([data-cancel])");
    const cancel = renderedToast?.querySelector("[data-cancel]");
    const close = renderedToast?.querySelector("[data-close-button]");

    expect(appBody.contains(toaster)).toBe(true);
    expect(document.body.querySelector("[data-sonner-toaster]")).toBeNull();
    expect(renderedToast?.getAttribute("data-styled")).toBe("false");
    expect([...renderedToast!.classList]).toEqual(
      expect.arrayContaining([
        "border-border",
        "bg-surface-elevated",
        "flex",
        "p-4",
        "rounded-8",
        "text-foreground",
        "shadow-4",
        "w-[var(--width)]",
      ]),
    );
    expect([...renderedToast!.classList]).not.toContain("bg-surface");
    expect(description?.className).toContain("text-muted-foreground");
    expect(description?.className).not.toContain("!text-muted-foreground");
    expect(action?.className).toContain("bg-primary");
    expect(action?.className).toContain("text-primary-foreground");
    expect(cancel?.className).toContain("bg-surface-muted");
    expect(cancel?.className).toContain("text-muted-foreground");
    expect(close?.className).toContain("bg-surface-elevated");
    expect(close?.className).toContain("border-border");
    expect(close?.className).toContain("text-foreground");
  });

  it("merges consumer overrides without dropping the wrapper contract", async () => {
    const { mountRoot } = mountShadowApp();

    render(
      <Toaster
        className="custom-toaster"
        style={{ "--custom-toaster-offset": "12px" } as CSSProperties}
        toastOptions={{
          unstyled: false,
          classNames: {
            toast: "bg-destructive",
            description: "text-destructive custom-description",
          },
        }}
      />,
      { container: mountRoot },
    );
    toast("App installed", { description: "The app is ready to open." });

    await waitFor(() => {
      expect(mountRoot.querySelector("[data-sonner-toast]")).not.toBeNull();
    });

    const toaster = mountRoot.querySelector("[data-sonner-toaster]") as HTMLElement;
    const renderedToast = mountRoot.querySelector("[data-sonner-toast]");
    const description = renderedToast?.querySelector("[data-description]");

    expect([...toaster.classList]).toEqual(
      expect.arrayContaining(["toaster", "group", "custom-toaster"]),
    );
    expect(toaster.style.getPropertyValue("--custom-toaster-offset")).toBe("12px");
    expect(toaster.style.getPropertyValue("--normal-text")).toBe("");
    expect(toaster.style.getPropertyValue("--normal-border")).toBe("");
    expect(toaster.getAttribute("data-sonner-theme")).toBe("light");
    expect(toaster.hasAttribute("data-rich-colors")).toBe(false);
    expect(renderedToast?.getAttribute("data-styled")).toBe("false");
    expect([...renderedToast!.classList]).toContain("bg-destructive");
    expect([...renderedToast!.classList]).not.toContain("bg-surface-elevated");
    expect(description?.className).toContain("text-destructive");
    expect(description?.className).not.toContain("text-muted-foreground");
    expect(description?.className).toContain("custom-description");
  });

  it("lets the icon slot grow with a glyph the caller sized", async () => {
    const { mountRoot } = mountShadowApp();

    render(<Toaster icons={{ success: <svg data-testid="glyph" className="size-6" /> }} />, {
      container: mountRoot,
    });
    toast.success("App installed");

    await waitFor(() => {
      expect(mountRoot.querySelector("[data-icon]")).not.toBeNull();
    });

    const slot = mountRoot.querySelector("[data-icon]") as HTMLElement;
    const cls = [...slot.classList];

    // The slot sizes from its child. Pinning it to the 16px default while the
    // rule below lets a glyph opt out is what lets a larger one eat the gap and
    // run under the title.
    expect(cls).toContain("[&_svg:not([class*='size-'])]:size-4");
    expect(cls.some((token) => /^size-\d/.test(token))).toBe(false);
    expect([...slot.querySelector("svg")!.classList]).toContain("size-6");
  });
});
