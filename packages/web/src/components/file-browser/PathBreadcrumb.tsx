import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  collapseBreadcrumb,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface PathCrumb {
  path: string;
  label: string;
}

interface PathBreadcrumbProps {
  /** Root first, current folder last. */
  crumbs: readonly PathCrumb[];
  onNavigate: (path: string) => void;
  /** Crumbs shown before the middle folds behind an ellipsis menu. */
  maxVisible?: number;
  "aria-label"?: string;
  className?: string;
  listClassName?: string;
}

/** A folder trail whose last crumb is the current folder. Long trails keep
 *  the root and the deepest folders, and list the rest in a menu. */
export function PathBreadcrumb({
  crumbs,
  onNavigate,
  maxVisible = 4,
  "aria-label": ariaLabel,
  className,
  listClassName,
}: PathBreadcrumbProps) {
  const { t } = useTranslation("files");
  const { leading, hidden, trailing } = collapseBreadcrumb(crumbs, maxVisible);
  const last = crumbs[crumbs.length - 1];

  const renderCrumb = (crumb: PathCrumb) => (
    <BreadcrumbItem key={crumb.path}>
      {crumb === last ? (
        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
      ) : (
        <BreadcrumbLink asChild>
          <button type="button" onClick={() => onNavigate(crumb.path)}>
            {crumb.label}
          </button>
        </BreadcrumbLink>
      )}
    </BreadcrumbItem>
  );

  const visible = [
    ...leading.map(renderCrumb),
    ...(hidden.length > 0
      ? [
          <BreadcrumbItem key="__hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <BreadcrumbEllipsis
                  label={t("pathBreadcrumb.showHidden", { count: hidden.length })}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={4} className="min-w-[10rem]">
                {hidden.map((crumb) => (
                  <DropdownMenuItem key={crumb.path} onSelect={() => onNavigate(crumb.path)}>
                    <Folder size={14} strokeWidth={1.6} aria-hidden="true" />
                    {crumb.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </BreadcrumbItem>,
        ]
      : []),
    ...trailing.map(renderCrumb),
  ];

  return (
    <Breadcrumb aria-label={ariaLabel} className={className}>
      <BreadcrumbList className={listClassName}>
        {visible.map((node, i) => (
          <Fragment key={node.key}>
            {i > 0 && <BreadcrumbSeparator />}
            {node}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
