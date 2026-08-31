import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Dialog, DialogBody, DialogDescription, DialogTitle } from "./dialog.js";
import { mountShadowApp } from "./test/shadow-app.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  rs.restoreAllMocks();
});

function openDialog(title = "Delete project") {
  return (
    <Dialog open onClose={() => {}}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>The project and its files will be deleted.</DialogDescription>
      <DialogBody>This cannot be undone.</DialogBody>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("takes its accessible name from its DialogTitle", () => {
    render(openDialog());

    // getByRole matches on the computed accessible name, so this fails if
    // `aria-labelledby` points at an id no element carries.
    const dialog = screen.getByRole("dialog", { name: "Delete project" });
    const title = screen.getByText("Delete project");
    const description = screen.getByText("The project and its files will be deleted.");

    expect(dialog).toBeTruthy();
    expect(title.className).toContain("text-title");
    expect(description.className).toContain("text-body");
  });

  it("keeps that name when rendered inside an app's shadow root", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();

    render(openDialog("Uninstall app"), { container: mountRoot });

    const content = shadowRoot.querySelector("[role=dialog]");
    const labelledBy = content?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    // Resolve within the shadow root — `document.getElementById` can't see in.
    expect(shadowRoot.getElementById(labelledBy as string)?.textContent).toBe("Uninstall app");
  });

  // In a shadow root the portal container resolves one commit after mount, so
  // React re-creates the portal — the case where a dialog that is already open
  // at mount could lose the focus Radix moved into it.
  it("holds focus inside a shadow-root dialog that mounts already open", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();

    render(openDialog(), { container: mountRoot });

    const content = shadowRoot.querySelector("[role=dialog]");
    expect(content?.contains(shadowRoot.activeElement)).toBe(true);
  });

  it("does not report a missing title for a titled dialog", () => {
    const errors: unknown[] = [];
    rs.spyOn(console, "error").mockImplementation((...args) => errors.push(args[0]));

    render(openDialog());

    expect(errors.filter((e) => String(e).includes("requires a `DialogTitle`"))).toHaveLength(0);
  });

  it("hides the rest of the page from assistive tech while open", () => {
    const page = document.createElement("div");
    page.textContent = "dashboard chrome";
    document.body.appendChild(page);

    render(openDialog());

    expect(page.getAttribute("aria-hidden")).toBe("true");
  });
});
