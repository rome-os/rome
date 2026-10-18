import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { LogOut, MessageSquarePlus, Settings, UserRound } from "lucide-react";
import { toast } from "sonner";
import { ShareFeedbackDialog } from "@/components/share-feedback";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDashboardIdentity } from "@/hooks/use-dashboard-identity";
import { fetchJson } from "@/lib/fetch-json";

// The signed-in identity anchor at the sidebar bottom: the Rome Cloud avatar
// when available, with initials as the local/password fallback. It opens the
// account menu (Settings, Feedback, Log out). Password and cloud guardians
// still resolve to the same guardian identity; only the bound Cloud profile
// supplies a picture. The wide sidebar also names the identity and its role
// beside the avatar; the rail has room for the avatar alone.
export function ProfileMenu({ showIdentity = false }: { showIdentity?: boolean } = {}) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const { data: identity } = useDashboardIdentity();
  const [signingOut, setSigningOut] = useState(false);
  // The dialog lives outside the menu: selecting an item closes the dropdown,
  // which would unmount a dialog rendered inside it.
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const title =
    identity?.kind === "guardian"
      ? (identity.displayName ?? t("profile.guardian"))
      : identity?.kind === "visitor"
        ? identity.email
        : null;
  const subtitle =
    identity?.kind === "guardian"
      ? identity.displayName
        ? t("profile.guardian")
        : null
      : identity?.kind === "visitor"
        ? t("profile.visitor")
        : null;
  // The wide button's accessible name starts with the name and role it shows,
  // so a voice user can say what they see.
  const identityLabel = [title, subtitle, t("profile.menuLabel")].filter(Boolean).join(", ");
  const initial = title?.trim().charAt(0).toUpperCase() ?? "";
  const avatarUrl =
    identity?.kind === "guardian" || identity?.kind === "visitor" ? identity.avatarUrl : null;

  const avatar = (
    <Avatar>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="bg-primary/15 text-primary">
        {initial || <UserRound className="size-4" aria-hidden />}
      </AvatarFallback>
    </Avatar>
  );

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetchJson<{ success: boolean }>("/api/auth/logout", {
        method: "POST",
        fallback: t("profile.signOutError"),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("profile.signOutError"));
      setSigningOut(false);
      return;
    }
    // Full navigation, not a client-side route: it drops every cached query
    // holding this user's data along with the rest of the JS state.
    window.location.assign("/login");
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {showIdentity ? (
            <button
              type="button"
              aria-label={identityLabel}
              title={title ?? t("profile.menuLabel")}
              className="flex min-h-[var(--control-min-h)] w-full min-w-0 items-center gap-2 rounded-8 px-1 py-1 text-left outline-none outline-1 outline-offset-0 outline-transparent transition hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50 dark:hover:bg-surface"
            >
              {avatar}
              {title ? (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui text-foreground">{title}</span>
                  {subtitle ? (
                    <span className="truncate text-aux text-subtle-foreground">{subtitle}</span>
                  ) : null}
                </span>
              ) : null}
            </button>
          ) : (
            <button
              type="button"
              aria-label={t("profile.menuLabel")}
              title={title ?? t("profile.menuLabel")}
              className="rounded-full outline-none outline-1 outline-offset-0 outline-transparent transition hover:opacity-80 focus-visible:outline-solid focus-visible:outline-ring/50 flex min-h-[var(--control-min-h)] min-w-[var(--control-min-h)] items-center justify-center"
            >
              {avatar}
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          {title ? (
            <>
              <DropdownMenuLabel className="flex flex-col gap-1">
                <span className="truncate text-ui text-foreground">{title}</span>
                {subtitle ? <span className="truncate text-aux">{subtitle}</span> : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => navigate("/settings")}>
            <Settings aria-hidden />
            {t("nav.settings")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
            <MessageSquarePlus aria-hidden />
            {t("feedback.open")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={signingOut}
            onSelect={(event) => {
              // Keep the menu open while the logout request is in flight so the
              // disabled state is visible and a double-click can't fire twice.
              event.preventDefault();
              void signOut();
            }}
          >
            <LogOut aria-hidden />
            {t("profile.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ShareFeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
