import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { projectHref } from "@/hooks/use-chat-projects";

interface ChatTitleProps {
  title: string;
  /** The chat's project, or null for a chat outside one. */
  projectPath: string | null;
}

// The chat's name, led by its project as a breadcrumb: `website-redesign ›
// Draft launch email`. A chat in a subfolder shows the whole path. The project
// links to its page. Both parts truncate when space runs out, the project
// capped so it never crowds the name out.
export function ChatTitle({ title, projectPath }: ChatTitleProps) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-ui">
      {projectPath ? (
        <>
          <Link
            to={projectHref(projectPath)}
            className="min-w-0 max-w-48 truncate rounded-4 text-muted-foreground outline-none outline-1 outline-offset-0 outline-transparent transition hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
          >
            {projectPath}
          </Link>
          <ChevronRight className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
        </>
      ) : null}
      <span className="min-w-0 truncate text-foreground">{title}</span>
    </span>
  );
}
