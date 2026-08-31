import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it } from "@rstest/core";
import { resolvePortalContainer } from "./portal-container.js";
import { mountShadowApp } from "./test/shadow-app.js";

// Unmount React roots before wiping the shadow hosts this file appends
// directly to document.body — wiping first would leave testing-library's own
// cleanup trying to remove nodes that are already gone.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("resolvePortalContainer", () => {
  it("portals an anchor inside a shadow root into that same shadow root", () => {
    const { shadowRoot, anchor } = mountShadowApp();

    const container = resolvePortalContainer(anchor);

    expect(container).toBeDefined();
    expect(container?.getRootNode()).toBe(shadowRoot);
  });

  it("keeps the container inside the anchor's top-level ancestor so theme classes still apply", () => {
    const { appBody, anchor } = mountShadowApp();
    appBody.classList.add("dark");

    const container = resolvePortalContainer(anchor);

    // The host toggles `.dark` on the shadow-root-level <body>; a container
    // outside it would render every `dark:` variant with light styling.
    expect(container?.parentElement).toBe(appBody);
    expect(container?.closest(".dark")).toBe(appBody);
  });

  it("lazily creates the container once and reuses it on later opens", () => {
    const { appBody, anchor } = mountShadowApp();

    const first = resolvePortalContainer(anchor);
    const second = resolvePortalContainer(anchor);

    expect(second).toBe(first);
    expect(
      Array.from(appBody.children).filter((c) => c.hasAttribute("data-rome-ui-portal")),
    ).toHaveLength(1);
  });

  it("falls back to the shadow root itself for an anchor with no ancestor inside it", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const anchor = document.createElement("div");
    shadowRoot.appendChild(anchor);

    const container = resolvePortalContainer(anchor);

    expect(container?.parentNode).toBe(shadowRoot);
    expect(anchor.contains(container ?? null)).toBe(false);
  });

  it("returns undefined for an anchor in the plain document (document.body default)", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);

    expect(resolvePortalContainer(anchor)).toBeUndefined();
  });

  it("returns undefined for a missing or detached anchor", () => {
    expect(resolvePortalContainer(null)).toBeUndefined();
    expect(resolvePortalContainer(undefined)).toBeUndefined();
    expect(resolvePortalContainer(document.createElement("button"))).toBeUndefined();
  });

  it("gives two shadow roots separate containers", () => {
    const appA = mountShadowApp();
    const appB = mountShadowApp();

    const containerA = resolvePortalContainer(appA.anchor);
    const containerB = resolvePortalContainer(appB.anchor);

    expect(containerA).not.toBe(containerB);
    expect(containerA?.getRootNode()).toBe(appA.shadowRoot);
    expect(containerB?.getRootNode()).toBe(appB.shadowRoot);
  });
});

// A floating component resolves its container from a trigger ref at open time —
// the shape the kit's floating family will use. Rendered into a shadow root the
// portal must stay inside it; in a plain document it must reach document.body.
function Floating({ label }: { label: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" ref={triggerRef} onClick={() => setOpen(true)}>
        open
      </button>
      {open &&
        createPortal(
          <div role="dialog">{label}</div>,
          resolvePortalContainer(triggerRef.current) ?? document.body,
        )}
    </>
  );
}

describe("a portaling component using the resolver", () => {
  it("keeps its floating content inside the shadow root it is rendered in", () => {
    const { shadowRoot, appBody } = mountShadowApp();
    const mount = document.createElement("div");
    appBody.appendChild(mount);

    const { getByRole } = render(<Floating label="in shadow" />, { container: mount });
    fireEvent.click(getByRole("button"));

    const dialog = shadowRoot.querySelector("[role=dialog]");
    expect(dialog?.textContent).toBe("in shadow");
    expect(appBody.contains(dialog)).toBe(true);
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
  });

  it("portals to document.body when rendered in the plain document", () => {
    const { getByRole, container } = render(<Floating label="in document" />);
    fireEvent.click(getByRole("button"));

    const dialog = document.body.querySelector("[role=dialog]");
    expect(dialog?.textContent).toBe("in document");
    expect(container.contains(dialog)).toBe(false);
  });
});
