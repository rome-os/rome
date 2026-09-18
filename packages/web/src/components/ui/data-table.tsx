import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface DataTableColumn<TData> {
  id: string;
  header: ReactNode;
  cell: (row: TData) => ReactNode;
  className?: string;
  headerClassName?: string;
  /**
   * The sort key this column's header sets. A column with no key keeps a plain
   * header, so the table offers sorting only where the caller's query can
   * actually order by it.
   */
  sortKey?: string;
}

export interface DataTableSort {
  key: string;
  direction: "asc" | "desc";
}

export interface DataTableProps<TData> {
  columns: DataTableColumn<TData>[];
  data: TData[];
  emptyMessage?: string;
  getRowKey: (row: TData) => string;
  loading?: boolean;
  loadingMessage?: string;
  onRowClick?: (row: TData) => void;
  /** The column the rows are ordered by, if the caller sorts through headers. */
  sort?: DataTableSort;
  /** Called with the next sort when a sortable header is activated. */
  onSortChange?: (sort: DataTableSort) => void;
}

function DataTable<TData>({
  columns,
  data,
  emptyMessage = "No results",
  getRowKey,
  loading = false,
  loadingMessage = "Loading",
  onRowClick,
  sort,
  onSortChange,
}: DataTableProps<TData>) {
  const message = loading ? loadingMessage : emptyMessage;
  // A header sorts only when the caller gave the column a key *and* is ready to
  // act on it, so a table with no handler never renders a control that does
  // nothing.
  const sortable = (column: DataTableColumn<TData>) =>
    column.sortKey !== undefined && onSortChange !== undefined;

  return (
    <div className="overflow-hidden rounded-12 border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => {
              if (!sortable(column)) {
                return (
                  <TableHead key={column.id} className={column.headerClassName}>
                    {column.header}
                  </TableHead>
                );
              }
              const active = sort !== undefined && sort.key === column.sortKey;
              const direction = active ? sort.direction : "desc";
              return (
                <TableHead
                  key={column.id}
                  className={column.headerClassName}
                  aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    // A first click takes the column at its most useful end —
                    // the largest or the latest — and a second click reverses
                    // it, which is the order a reader expects from a table.
                    onClick={() =>
                      onSortChange?.({
                        key: column.sortKey as string,
                        direction: active && direction === "desc" ? "asc" : "desc",
                      })
                    }
                    className={cn(
                      "-mx-1 inline-flex items-center gap-1 rounded-8 px-1 transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring",
                      active && "text-foreground",
                    )}
                  >
                    {column.header}
                    {active ? (
                      direction === "asc" ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : (
                        <ArrowDown className="size-3" aria-hidden />
                      )
                    ) : null}
                  </button>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-10 text-center text-muted-foreground"
              >
                {message}
              </TableCell>
            </TableRow>
          ) : (
            data.map((row) => (
              <TableRow
                key={getRowKey(row)}
                className={cn(onRowClick && "cursor-pointer")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <TableCell key={column.id} className={column.className}>
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export { DataTable };
