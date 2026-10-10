import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Globe,
  GitFork,
  Info,
  Maximize2,
  MessageCircle,
  Pin,
  Power,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { canRemixApp } from "@/components/app-remix-dialog";
import { TileIcon } from "@/components/app-tile-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  dropdownMenuItemVariants,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { type AppLifecycle, canChatWithApp } from "@/hooks/use-app-lifecycle";
import { cn } from "@/lib/utils";

// One installed app's actions menu as data, shared by every surface that
// offers it: the launcher grid's tile menu and the embedded-app floating
// widget. The builder owns which entries exist, their order, and their
// capability gating; each surface renders the same entries into its own
// chrome (Radix menu items on fine pointers, a bottom action sheet on touch)
// — the same split the file browser uses (file-browser/ContextMenu.tsx).

type ActionIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export type AppActionMenuEntry =
  | { type: "separator"; key: string }
  | {
      type: "action";
      key: string;
      label: string;
      icon: ActionIcon;
      disabled?: boolean;
      destructive?: boolean;
      onSelect: () => void;
    }
  | { type: "link"; key: string; label: string; icon: ActionIcon; to: string };

// The upgrade entry's marker is a status dot, not a glyph. Drawn as an svg so
// both renderers size it exactly like the Lucide icons beside it; the 8/14
// circle-to-box ratio matches the grid's original span-based dot.
function UpgradeDot({ className, ...props }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <svg viewBox="0 0 14 14" className={className} {...props}>
      <circle cx="7" cy="7" r="4" className="fill-success" />
    </svg>
  );
}

export interface AppActionMenuOptions {
  app: InstalledAppCard;
  lifecycle: AppLifecycle;
  t: TFunction<"apps">;
  /** True while any lifecycle/access write is in flight — grays mutating entries. */
  disabled: boolean;
  /** Pin/Unpin shows only for an app with an embedded frontend href. */
  pin: { pinned: boolean; onToggle: () => void };
  /** Remix shows only when canRemixApp passes. */
  onRemix: () => void;
}

// Always yields at least "View details", so the menu never collapses to empty
// even when no lifecycle action applies (e.g. the system app).
export function getAppActionMenuEntries({
  app,
  lifecycle,
  t,
  disabled,
  pin,
  onRemix,
}: AppActionMenuOptions): AppActionMenuEntry[] {
  const isActing = lifecycle.isAppActing(app.id);
  const candidate = lifecycle.freshCandidate(app);
  const embeddedHref = app.hasFrontend && app.href ? app.href : null;
  const entries: AppActionMenuEntry[] = [];

  if (canRemixApp(app)) {
    entries.push({
      type: "action",
      key: "remix",
      label: t("installed.remix"),
      icon: GitFork,
      disabled,
      onSelect: onRemix,
    });
    entries.push({ type: "separator", key: "remix-separator" });
  }
  if (candidate) {
    entries.push({
      type: "action",
      key: "upgrade",
      label: isActing
        ? t("installed.upgrading")
        : t("installed.upgradeButton", { version: candidate.availableVersion }),
      icon: UpgradeDot,
      disabled,
      onSelect: () => lifecycle.upgrade(app),
    });
    entries.push({ type: "separator", key: "upgrade-separator" });
  }
  entries.push({
    type: "link",
    key: "details",
    label: t("installed.viewDetails"),
    icon: Info,
    to: `/app-details/${encodeURIComponent(app.id)}`,
  });
  if (canChatWithApp(app)) {
    entries.push({
      type: "action",
      key: "chat",
      label: t("installed.chatWithApp"),
      icon: MessageCircle,
      onSelect: () => lifecycle.chatWithApp(app),
    });
  }
  if (app.fullHref) {
    entries.push({
      type: "link",
      key: "full-view",
      label: t("installed.openFullTitle"),
      icon: Maximize2,
      to: app.fullHref,
    });
  }
  if (embeddedHref) {
    entries.push({
      type: "action",
      key: "pin",
      label: pin.pinned ? t("installed.unpin") : t("installed.pin"),
      icon: Pin,
      onSelect: pin.onToggle,
    });
  }
  if (app.canManagePublicAccess || app.canPublish) {
    entries.push({ type: "separator", key: "distribution-separator" });
    if (app.canManagePublicAccess) {
      entries.push({
        type: "action",
        key: "access",
        label: t("installed.access"),
        icon: Globe,
        onSelect: () => lifecycle.requestAccess(app),
      });
    }
    if (app.canPublish) {
      entries.push({
        type: "action",
        key: "publish",
        label: isActing ? t("installed.publishing") : t("installed.publish"),
        icon: Upload,
        disabled,
        onSelect: () => lifecycle.requestPublish(app),
      });
    }
  }
  if (app.canToggle || app.canUninstall) {
    entries.push({ type: "separator", key: "danger-separator" });
    if (app.canToggle) {
      entries.push({
        type: "action",
        key: "toggle",
        label: isActing
          ? app.isEnabled
            ? t("toggle.disabling")
            : t("toggle.enabling")
          : app.isEnabled
            ? t("toggle.disable")
            : t("toggle.enable"),
        icon: Power,
        disabled,
        destructive: app.isEnabled,
        onSelect: () => lifecycle.toggle(app),
      });
    }
    if (app.canUninstall) {
      entries.push({
        type: "action",
        key: "uninstall",
        label: t("installed.uninstall"),
        icon: Trash2,
        disabled,
        destructive: true,
        onSelect: () => lifecycle.requestUninstall(app, false),
      });
      entries.push({
        type: "action",
        key: "uninstall-purge",
        label: t("installed.uninstallPurge"),
        icon: Trash2,
        disabled,
        destructive: true,
        onSelect: () => lifecycle.requestUninstall(app, true),
      });
    }
  }
  return entries;
}

// Fine-pointer renderer: Radix menu items inside a DropdownMenuContent. The
// explicit item/icon classes are the grid tile menu's original treatment —
// destructive entries restate the colors the kit's `variant` prop would give
// because the grid predates it and the two palettes differ (destructive-fg vs
// destructive); keeping the grid's own is the no-visual-change option.
export function AppActionDropdownItems({ entries }: { entries: AppActionMenuEntry[] }) {
  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "separator") return <DropdownMenuSeparator key={entry.key} />;
        const Icon = entry.icon;
        const destructive = entry.type === "action" && entry.destructive === true;
        const icon = (
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              destructive ? "text-destructive-fg" : "text-subtle-foreground",
            )}
            aria-hidden
          />
        );
        if (entry.type === "link") {
          return (
            <DropdownMenuItem key={entry.key} asChild>
              <Link to={entry.to} className="text-foreground">
                {icon}
                {entry.label}
              </Link>
            </DropdownMenuItem>
          );
        }
        return (
          <DropdownMenuItem
            key={entry.key}
            onClick={entry.onSelect}
            disabled={entry.disabled}
            className={
              destructive ? "text-destructive-fg focus:bg-destructive-bg" : "text-foreground"
            }
          >
            {icon}
            {entry.label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * Touch renderer: a bottom action sheet (same recipe as the file browser's
 * FileActionSheet — grab handle, identity header, `size: "touch"` rows,
 * safe-area bottom padding). The header restates which app the actions target
 * because, unlike the anchored dropdown, the sheet detaches from its trigger —
 * and destructive entries sit at the bottom of a full-width surface.
 */
export function AppActionSheet({
  open,
  app,
  entries,
  closeLabel,
  onClose,
}: {
  open: boolean;
  app: InstalledAppCard;
  entries: AppActionMenuEntry[];
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="rome-backdrop-fade fixed inset-0 z-50 bg-foreground/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="rome-sheet-rise fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-16 border-t border-border bg-surface text-foreground shadow-25 outline-none"
        >
          <div className="flex shrink-0 justify-center pb-1 pt-2" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-border-strong" />
          </div>
          <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 pb-3 pt-1">
            <TileIcon
              kind="image"
              displayName={app.displayName}
              iconUrl={app.iconUrl}
              muted={app.status === "disabled"}
            />
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-section">
                {app.displayName}
              </DialogPrimitive.Title>
              <p className="truncate text-aux text-muted-foreground">
                {app.id} &middot; v{app.version}
              </p>
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label={closeLabel}
                title={closeLabel}
                className="rounded-full text-muted-foreground hover:bg-surface-muted dark:hover:bg-surface-muted"
              >
                <X className="size-5" aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto px-3 pb-[max(var(--rome-safe-area-bottom),0.75rem)] pt-2">
            {entries.map((entry) => {
              if (entry.type === "separator") {
                return <Separator key={entry.key} className="my-2" decorative={false} />;
              }
              const Icon = entry.icon;
              if (entry.type === "link") {
                return (
                  <Link
                    key={entry.key}
                    to={entry.to}
                    onClick={onClose}
                    className={dropdownMenuItemVariants({ size: "touch" })}
                  >
                    <Icon aria-hidden />
                    <span>{entry.label}</span>
                  </Link>
                );
              }
              return (
                <button
                  key={entry.key}
                  type="button"
                  data-variant={entry.destructive ? "destructive" : "default"}
                  disabled={entry.disabled}
                  onClick={() => {
                    onClose();
                    entry.onSelect();
                  }}
                  className={dropdownMenuItemVariants({ size: "touch" })}
                >
                  <Icon aria-hidden />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
