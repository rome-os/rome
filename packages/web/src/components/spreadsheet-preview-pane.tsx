import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { read, utils } from "xlsx";
import { Button } from "@/components/ui/button";

// Parsing runs on the main thread and unzips the whole workbook first, so
// larger files go straight to download instead of freezing the tab. A
// deliberately crafted zip bomb under this cap can still stall the tab; that
// only affects the viewer's own page.
const MAX_SPREADSHEET_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_SPREADSHEET_ROWS = 200;
const MAX_SPREADSHEET_COLUMNS = 50;

interface SpreadsheetSheetPreview {
  name: string;
  rows: string[][];
  totalRows: number;
  totalColumns: number;
}

/** Read a workbook into display-ready sheets: formatted cell text (formula
 *  results, dates and percentages as the workbook formats them), capped at
 *  200 rows × 50 columns per sheet. Throws on a malformed or
 *  password-protected file. */
export function readSpreadsheetPreview(data: ArrayBuffer): SpreadsheetSheetPreview[] {
  const workbook = read(data, { type: "array", sheetRows: MAX_SPREADSHEET_ROWS });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    // `sheetRows` trims `!ref` to the rows read; `!fullref` keeps the real size.
    const fullRef = sheet?.["!fullref"] ?? sheet?.["!ref"];
    const range = fullRef ? utils.decode_range(fullRef) : null;
    const rows = sheet
      ? utils
          .sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true })
          .map((row) => row.slice(0, MAX_SPREADSHEET_COLUMNS).map((cell) => String(cell ?? "")))
      : [];
    return {
      name,
      rows,
      totalRows: range ? range.e.r - range.s.r + 1 : 0,
      totalColumns: range ? range.e.c - range.s.c + 1 : 0,
    };
  });
}

interface SpreadsheetPreviewPaneProps {
  assetUrl: string;
  size: number;
  title: string;
}

export function SpreadsheetPreviewPane({ assetUrl, size, title }: SpreadsheetPreviewPaneProps) {
  const { t } = useTranslation("files");
  const tooLarge = size > MAX_SPREADSHEET_PREVIEW_BYTES;
  const [sheets, setSheets] = useState<SpreadsheetSheetPreview[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (tooLarge) return;
    const abortController = new AbortController();
    setSheets(null);
    setFailed(false);
    setActiveIndex(0);
    void (async () => {
      try {
        const response = await fetch(assetUrl, { signal: abortController.signal });
        if (!response.ok) throw new Error(`Failed to fetch spreadsheet: ${response.status}`);
        const parsed = readSpreadsheetPreview(await response.arrayBuffer());
        if (!abortController.signal.aborted) setSheets(parsed);
      } catch (error) {
        if (abortController.signal.aborted) return;
        console.error("Failed to render spreadsheet preview:", error);
        setFailed(true);
      }
    })();
    return () => abortController.abort();
  }, [assetUrl, tooLarge]);

  if (tooLarge || failed) {
    return (
      <div className="flex h-full items-center justify-center bg-surface p-6">
        <div className="max-w-md text-center">
          <h3 className="text-section text-foreground">
            {t(tooLarge ? "view.spreadsheetTooLargeTitle" : "view.spreadsheetPreviewFailedTitle")}
          </h3>
          <p className="mt-2 text-ui text-muted-foreground">
            {t(
              tooLarge
                ? "view.spreadsheetTooLargeDescription"
                : "view.spreadsheetPreviewFailedDescription",
            )}
          </p>
        </div>
      </div>
    );
  }

  if (!sheets) {
    return (
      <div className="flex h-full items-center justify-center bg-surface p-6">
        <p className="text-ui text-subtle-foreground">{t("view.loadingSpreadsheet")}</p>
      </div>
    );
  }

  const sheet = sheets[activeIndex] ?? sheets[0];
  const columnsTruncated = !!sheet && sheet.totalColumns > MAX_SPREADSHEET_COLUMNS;
  const truncated = !!sheet && (sheet.totalRows > sheet.rows.length || columnsTruncated);

  return (
    <div className="flex h-full flex-col bg-surface" aria-label={title}>
      {sheets.length > 1 && (
        <div
          role="tablist"
          aria-label={t("view.spreadsheetSheets")}
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-2 md:px-6"
        >
          {sheets.map((entry, index) => (
            <Button
              key={`${index}:${entry.name}`}
              role="tab"
              aria-selected={index === activeIndex}
              size="sm"
              variant={index === activeIndex ? "secondary" : "ghost"}
              className="shrink-0"
              onClick={() => setActiveIndex(index)}
            >
              {entry.name}
            </Button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {truncated && (
          <p className="mb-3 text-ui text-muted-foreground">
            {t(columnsTruncated ? "view.spreadsheetTruncated" : "view.spreadsheetTruncatedRows", {
              rows: sheet.rows.length,
              totalRows: sheet.totalRows,
              columns: Math.min(sheet.totalColumns, MAX_SPREADSHEET_COLUMNS),
              totalColumns: sheet.totalColumns,
            })}
          </p>
        )}
        {!sheet || sheet.rows.length === 0 ? (
          <p className="text-ui text-muted-foreground">{t("view.noRowsToPreview")}</p>
        ) : (
          <table className="min-w-full border-collapse text-left text-ui">
            <tbody>
              {sheet.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex === 0 ? "bg-surface-muted" : undefined}>
                  {row.map((cell, cellIndex) => {
                    const Cell = rowIndex === 0 ? "th" : "td";
                    return (
                      <Cell
                        key={cellIndex}
                        className="border border-border px-3 py-2 align-top text-foreground"
                      >
                        {cell}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
