import { FolderKanban, Plus, Search } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state.js";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RomeInputDialog } from "@/components/rome-input-dialog";
import {
  createChatProject,
  projectHref,
  useChatProjects,
  type ChatProject,
} from "@/hooks/use-chat-projects";
import { activityTime } from "./activity-time";
import { ListCollection, ListGrid, ListToolbar } from "@rome-os/ui/layout-list";
import {
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@rome-os/ui/page";

// A folder name the projects root accepts: one path segment, no dot-prefixed
// or traversal names.
function parseProjectName(value: string): string | null {
  const name = value.trim();
  if (!name || name.startsWith(".") || /[\\/]/.test(name)) return null;
  return name;
}

function ProjectCard({ project }: { project: ChatProject }) {
  const { t, i18n } = useTranslation("common");
  const latest = project.chats[0];
  return (
    <Link
      to={projectHref(project.path)}
      className="flex min-h-32 flex-col gap-3 rounded-12 border border-border bg-surface p-4 outline-none outline-1 outline-offset-0 outline-transparent transition hover:border-border-strong hover:shadow-1 focus-visible:outline-solid focus-visible:outline-ring/50"
    >
      <div className="flex min-w-0 items-center gap-2">
        <FolderKanban className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
        <span className="truncate text-ui text-foreground">{project.name}</span>
      </div>
      {latest ? (
        <p className="line-clamp-2 text-aux text-muted-foreground">{latest.name}</p>
      ) : (
        <p className="text-aux text-subtle-foreground">{t("projectsPage.noChatsYet")}</p>
      )}
      <p className="mt-auto text-aux text-subtle-foreground">
        {t("projectsPage.chatCount", { count: project.chats.length })}
        {project.activityAt
          ? ` · ${t("projectsPage.updated", { when: activityTime(project.activityAt, i18n.language) })}`
          : null}
      </p>
    </Link>
  );
}

// The Projects list: every project folder as a card, most recently active
// first. A project is a folder; its chats and files open from its page.
export default function ProjectsIndexPage() {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const { projects, error, refetch, invalidate } = useChatProjects();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // The dialog stays open until the POST answers; a second Enter or click in
  // that window would ask core to create the same project again. The ref
  // guards the same tick, and the state shows the dialog as busy.
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  // Bumped on every close, so a create that answers after Cancel doesn't
  // carry the guardian into the project they backed out of.
  const dialogSession = useRef(0);

  const normalizedQuery = query.trim().toLowerCase();
  const visible =
    projects?.filter((project) => project.name.toLowerCase().includes(normalizedQuery)) ?? null;

  const closeCreate = () => {
    dialogSession.current += 1;
    setCreating(false);
    setCreateError(null);
  };

  const create = async (value: string) => {
    const name = parseProjectName(value);
    if (!name) {
      setCreateError(t("projectsPage.invalidName"));
      return;
    }
    if (projects?.some((project) => project.path === name)) {
      setCreateError(t("projectsPage.nameTaken", { name }));
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setCreateError(null);
    const session = dialogSession.current;
    try {
      const path = await createChatProject(name);
      const cancelled = session !== dialogSession.current;
      if (!cancelled) closeCreate();
      await invalidate();
      if (!cancelled) navigate(projectHref(path));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("projectsPage.createFailed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>{t("projectsPage.title")}</PageTitle>
          <PageDescription>{t("projectsPage.description")}</PageDescription>
        </PageHeading>
        <PageActions>
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" className="h-3.5 w-3.5" aria-hidden />
            {t("projectsPage.newProject")}
          </Button>
        </PageActions>
      </PageHeader>

      <ListToolbar aria-label={t("projectsPage.toolbarLabel")}>
        <div className="relative w-full sm:max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("projectsPage.searchPlaceholder")}
            aria-label={t("projectsPage.searchPlaceholder")}
            className="pl-8"
          />
        </div>
      </ListToolbar>

      <ListCollection>
        {error && projects === null ? (
          <EmptyState role="alert">
            <EmptyStateTitle>{t("projectsPage.loadError")}</EmptyStateTitle>
            <EmptyStateAction>
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                {t("projectsPage.retry")}
              </Button>
            </EmptyStateAction>
          </EmptyState>
        ) : visible === null ? (
          <ListGrid aria-busy>
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-32 rounded-12" />
            ))}
          </ListGrid>
        ) : visible.length === 0 ? (
          <EmptyState role="status">
            <EmptyStateIcon>
              <FolderKanban className="h-5 w-5" aria-hidden />
            </EmptyStateIcon>
            <EmptyStateTitle>
              {normalizedQuery
                ? t("projectsPage.noMatches", { query: query.trim() })
                : t("projectsPage.empty")}
            </EmptyStateTitle>
            {normalizedQuery ? null : (
              <EmptyStateDescription>{t("projectsPage.emptyHint")}</EmptyStateDescription>
            )}
          </EmptyState>
        ) : (
          <ListGrid>
            {visible.map((project) => (
              <ProjectCard key={project.path} project={project} />
            ))}
          </ListGrid>
        )}
      </ListCollection>

      <RomeInputDialog
        open={creating}
        onCancel={closeCreate}
        onConfirm={(value) => void create(value)}
        title={t("projectsPage.createTitle")}
        description={t("projectsPage.createDescription")}
        inputLabel={t("projectsPage.nameLabel")}
        initialValue=""
        confirmLabel={t("projectsPage.create")}
        cancelLabel={t("projectsPage.cancel")}
        error={createError}
        busy={busy}
        icon={<FolderKanban className="h-4 w-4" aria-hidden />}
      />
    </Page>
  );
}
