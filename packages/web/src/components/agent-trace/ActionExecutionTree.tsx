import { useState } from "react";
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  Minus,
  Plus,
  ListTree,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { artifactLocalName } from "@/lib/artifact-name";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { formatDuration } from "./CollapsedTraceSummary";

// One node per `action_executions` row, already reconstructed into a tree by
// `parentId` (see the routine-trace endpoint). A node is itself a tree: it owns
// its children, so every node supports the same collapse/expand controls.

export type ActionStatus = "running" | "success" | "error" | "pending_approval" | "cancelled";

export interface ActionNode {
  id: string;
  actionName: string;
  status: ActionStatus;
  /** Wall-clock from `durationMs`. Null while still running. */
  durationMs: number | null;
  /** Present only on a failed node — the swallowed-tool message. */
  error?: string | null;
  actionType?: string | null;
  initiator?: string | null;
  /** Authenticated session identity accountable for the run (guardian /
   * visitor / anonymous), when the chain originated from one. */
  actor?: {
    kind: "guardian" | "visitor" | "anonymous";
    email?: string;
    accountId?: string;
  } | null;
  /** The action's input args; rendered as JSON in the detailed view. */
  args?: unknown;
  /** Epoch seconds (the schema stores `{mode:"timestamp"}` = seconds). */
  startedAt?: number | null;
  finishedAt?: number | null;
  children: ActionNode[];
}

const STATUS_META: Record<
  ActionStatus,
  { label: string; variant: BadgeProps["variant"]; Icon: typeof CircleCheck; spin?: boolean }
> = {
  success: { label: "success", variant: "success", Icon: CircleCheck },
  error: { label: "error", variant: "destructive", Icon: CircleX },
  running: { label: "running", variant: "info", Icon: LoaderCircle, spin: true },
  pending_approval: { label: "pending", variant: "warning", Icon: Clock },
  cancelled: { label: "cancelled", variant: "muted", Icon: Ban },
};

// Reuse the turn-trace duration formatter so durations read identically across
// both trace surfaces. It returns null for missing/invalid input; we render an
// em dash in that case.
const dur = (ms: number | null | undefined): string => formatDuration(ms ?? undefined) ?? "—";

const actorLabel = (actor: NonNullable<ActionNode["actor"]>): string => {
  if (actor.kind === "guardian") return actor.email ? `Guardian · ${actor.email}` : "Guardian";
  if (actor.kind === "visitor") return actor.email ?? actor.accountId ?? "Visitor";
  return "Anonymous";
};

// Visibility lives in one `Set<id>`: a node's children render iff its id is in
// the set. Because rendering recurses, an indirect child only appears when every
// ancestor is expanded — so "collapse" needs only drop ids, never track depth.

function descendantIds(node: ActionNode): string[] {
  return node.children.flatMap((c) => [c.id, ...descendantIds(c)]);
}

/** A node is "fully expanded" when it and every descendant-with-children is open. */
function isFullyExpanded(node: ActionNode, expanded: Set<string>): boolean {
  if (node.children.length === 0) return true;
  if (!expanded.has(node.id)) return false;
  return node.children.every((c) => isFullyExpanded(c, expanded));
}

export function ActionExecutionTree({
  roots,
  className,
}: {
  roots: ActionNode[];
  className?: string;
}) {
  // Start with every direct child of the roots visible.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(roots.map((r) => r.id)));

  // expand: reveal direct children only (add this node's id).
  const expand = (node: ActionNode) => setExpanded((prev) => new Set(prev).add(node.id));

  // collapse: hide direct AND indirect children. Dropping this node plus every
  // descendant id resets the subtree, so a later single `expand` doesn't snap
  // a previously deep-expanded subtree back into view.
  const collapse = (node: ActionNode) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(node.id);
      for (const id of descendantIds(node)) next.delete(id);
      return next;
    });

  // full expand: reveal direct and indirect children (add this node + all descendants).
  const fullExpand = (node: ActionNode) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(node.id);
      for (const id of descendantIds(node)) next.add(id);
      return next;
    });

  return (
    <ul role="tree" className={cn("flex flex-col gap-1 text-ui", className)}>
      {roots.map((node) => (
        <ActionTreeNode
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          onExpand={expand}
          onCollapse={collapse}
          onFullExpand={fullExpand}
        />
      ))}
    </ul>
  );
}

function ActionTreeNode({
  node,
  depth,
  expanded,
  onExpand,
  onCollapse,
  onFullExpand,
}: {
  node: ActionNode;
  depth: number;
  expanded: Set<string>;
  onExpand: (n: ActionNode) => void;
  onCollapse: (n: ActionNode) => void;
  onFullExpand: (n: ActionNode) => void;
}) {
  // Detail (compact ↔ detailed) is per-node and independent of subtree visibility.
  const [detailOpen, setDetailOpen] = useState(false);

  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const fullyExpanded = isFullyExpanded(node, expanded);
  const meta = STATUS_META[node.status];
  const actionLabel = artifactLocalName(node.actionName);

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
      {/* Compact row: status · name · duration, plus structure controls. */}
      <div className="flex items-center gap-1 rounded-8 pr-1 hover:bg-surface-muted">
        <button
          type="button"
          onClick={() => setDetailOpen((v) => !v)}
          aria-expanded={detailOpen}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-8 py-1 pl-2 text-left"
        >
          <meta.Icon
            className={cn(
              "h-4 w-4 flex-none",
              node.status === "success" && "text-success-fg",
              node.status === "error" && "text-destructive-fg",
              node.status === "running" && "text-info-fg",
              node.status === "pending_approval" && "text-warning-fg",
              node.status === "cancelled" && "text-muted-foreground",
              meta.spin && "animate-spin",
            )}
          />
          <span
            className="min-w-0 truncate text-foreground"
            title={actionLabel === node.actionName ? undefined : node.actionName}
          >
            {actionLabel}
          </span>
          {/* Surface the failure on the compact line so a collapsed subtree still hints at it. */}
          {node.status === "error" && (
            <Badge variant="destructive" shape="square" className="flex-none">
              {meta.label}
            </Badge>
          )}
          <span className="flex-1" />
          <span className="flex-none font-mono text-aux text-muted-foreground">
            {dur(node.durationMs)}
          </span>
        </button>

        {hasChildren && (
          <div className="flex flex-none items-center gap-1">
            <IconButton
              size="sm"
              label="Collapse"
              disabled={!isOpen}
              onClick={(e) => {
                e.stopPropagation();
                onCollapse(node);
              }}
              icon={<Minus />}
            />
            <IconButton
              size="sm"
              label="Expand children"
              disabled={isOpen}
              onClick={(e) => {
                e.stopPropagation();
                onExpand(node);
              }}
              icon={<Plus />}
            />
            <IconButton
              size="sm"
              label="Expand all"
              disabled={fullyExpanded}
              onClick={(e) => {
                e.stopPropagation();
                onFullExpand(node);
              }}
              icon={<ListTree />}
            />
          </div>
        )}
      </div>

      {/* Detailed view: error first, then args + timing metadata. */}
      {detailOpen && (
        <div className="ml-6 mb-1 flex flex-col gap-2 rounded-8 border border-border bg-surface px-3 py-2 text-aux">
          {node.error && (
            <div className="rounded-8 bg-destructive-bg px-2 py-1 font-mono text-destructive-fg">
              {node.error}
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
            <DetailRow label="Status">{meta.label}</DetailRow>
            <DetailRow label="Duration">{dur(node.durationMs)}</DetailRow>
            {node.actionType && <DetailRow label="Type">{node.actionType}</DetailRow>}
            {node.initiator && <DetailRow label="Initiator">{node.initiator}</DetailRow>}
            {node.actor && <DetailRow label="By">{actorLabel(node.actor)}</DetailRow>}
            {node.args != null && (
              <DetailRow label="Args">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
                  {JSON.stringify(node.args, null, 2)}
                </pre>
              </DetailRow>
            )}
          </dl>
        </div>
      )}

      {/* Children: a left rail conveys nesting; rendered only when this node is open. */}
      {hasChildren && isOpen && (
        <ul role="group" className="ml-4 flex flex-col gap-1 border-l border-border pl-2">
          {node.children.map((child) => (
            <ActionTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onExpand={onExpand}
              onCollapse={onCollapse}
              onFullExpand={onFullExpand}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}
