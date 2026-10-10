import { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "./popover.js";

const ACTIONS_SELECTOR = '[data-streamdown="mermaid-block-actions"]';

interface DownloadItem {
  button: HTMLButtonElement;
  label: string;
  text: string;
  title: string;
}

interface DownloadMenu {
  items: DownloadItem[];
  menu: HTMLElement;
  trigger: HTMLButtonElement;
}

function readDownloadMenus(root: ParentNode): DownloadMenu[] {
  const menus: DownloadMenu[] = [];
  for (const actions of root.querySelectorAll(ACTIONS_SELECTOR)) {
    // Streamdown exposes a hook for the action bar but not its download menu.
    // The download control is the direct wrapper that owns both a button and a
    // menu, while the other actions are direct buttons.
    for (const child of actions.children) {
      const trigger = Array.from(child.children).find((element) => element.tagName === "BUTTON") as
        | HTMLButtonElement
        | undefined;
      const menu = Array.from(child.children).find((element) => element.tagName === "DIV") as
        | HTMLElement
        | undefined;
      if (!trigger || !menu) continue;

      const items = Array.from(menu.children)
        .filter((element): element is HTMLButtonElement => element.tagName === "BUTTON")
        .map((button) => ({
          button,
          label: button.getAttribute("aria-label") ?? button.textContent ?? "",
          text: button.textContent ?? "",
          title: button.title,
        }));
      if (items.length > 0) {
        menus.push({ items, menu, trigger });
      }
    }
  }
  return menus;
}

function sameMenus(left: DownloadMenu[], right: DownloadMenu[]): boolean {
  return (
    left.length === right.length && left.every((menu, index) => menu.menu === right[index]?.menu)
  );
}

function PortaledDownloadMenu({ menu }: { menu: DownloadMenu }) {
  const virtualRef = useMemo(() => ({ current: menu.trigger }), [menu.trigger]);
  const contentRef = useRef<HTMLDivElement>(null);
  const interactedOutside = useRef(false);

  return (
    <Popover open>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        align="end"
        aria-label={menu.trigger.getAttribute("aria-label") ?? undefined}
        className="max-h-[var(--radix-popover-content-available-height)] w-auto min-w-[120px] gap-0 overflow-y-auto border border-border bg-background p-0 shadow-lg ring-0"
        collisionPadding={8}
        data-rome-mermaid-download-menu=""
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // A portal can remount into a Shadow DOM while the source menu stays open.
          if (!menu.menu.isConnected && !interactedOutside.current) menu.trigger.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          menu.trigger.click();
          menu.trigger.focus();
        }}
        onInteractOutside={() => {
          interactedOutside.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            menu.trigger.click();
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ),
          );
          const current = items.indexOf(event.target as HTMLButtonElement);
          let next = 0;
          switch (event.key) {
            case "ArrowDown":
              next = (current + 1) % items.length;
              break;
            case "ArrowUp":
              next = current <= 0 ? items.length - 1 : current - 1;
              break;
            case "End":
              next = items.length - 1;
              break;
          }
          items[next]?.focus();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // Radix's default focus lookup stops at the shadow host in app portals.
          const content = contentRef.current;
          const first = content?.querySelector<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          );
          (first ?? content)?.focus();
        }}
        ref={contentRef}
        role="menu"
        side="bottom"
      >
        {menu.items.map((item, index) => (
          <button
            aria-label={item.label}
            className="w-full px-3 py-2 text-left text-ui transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
            disabled={item.button.disabled}
            key={`${item.label}-${index}`}
            onClick={() => item.button.click()}
            role="menuitem"
            title={item.title}
            type="button"
          >
            {item.text}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function MermaidDownloadMenuLayer({ root }: { root: HTMLElement | null }) {
  const [menus, setMenus] = useState<DownloadMenu[]>([]);

  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!root || !win) return;
    const managed = new Map<HTMLElement, string>();

    const sync = () => {
      const next = readDownloadMenus(root);
      for (const [menu, display] of managed) {
        if (!next.some((candidate) => candidate.menu === menu)) {
          if (menu.isConnected) menu.style.display = display;
          managed.delete(menu);
        }
      }
      for (const entry of next) {
        if (!managed.has(entry.menu)) managed.set(entry.menu, entry.menu.style.display);
        entry.menu.style.display = "none";
      }
      setMenus((current) => (sameMenus(current, next) ? current : next));
    };

    const observer = new win.MutationObserver(sync);
    const syncAfterClick = () => win.queueMicrotask(sync);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("click", syncAfterClick);
    sync();
    return () => {
      observer.disconnect();
      root.removeEventListener("click", syncAfterClick);
      for (const [menu, display] of managed) menu.style.display = display;
    };
  }, [root]);

  return menus.map((menu, index) => <PortaledDownloadMenu key={index} menu={menu} />);
}
