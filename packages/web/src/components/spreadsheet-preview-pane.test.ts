import { describe, expect, it } from "@rstest/core";
import { utils, write } from "xlsx";
import { readSpreadsheetPreview } from "@/components/spreadsheet-preview-pane";
import { isSpreadsheetPath } from "@/lib/file-preview";

function workbookBytes(sheets: Record<string, ReturnType<typeof utils.aoa_to_sheet>>): ArrayBuffer {
  const workbook = utils.book_new();
  for (const [name, sheet] of Object.entries(sheets))
    utils.book_append_sheet(workbook, sheet, name);
  return write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("readSpreadsheetPreview", () => {
  it("shows every sheet with formatted values and formula results", () => {
    const report = utils.aoa_to_sheet([
      ["Month", "Share", "Total"],
      ["Jan", 0.25, 3],
    ]);
    report.B2 = { t: "n", v: 0.25, z: "0%" };
    report.C2 = { t: "n", v: 3, f: "1+2" };
    report.A3 = { t: "n", v: 46000, z: "yyyy-mm-dd" };
    report["!ref"] = "A1:C3";
    const notes = utils.aoa_to_sheet([["Note"], ["Draft"]]);

    const sheets = readSpreadsheetPreview(workbookBytes({ Report: report, Notes: notes }));

    expect(sheets.map((sheet) => sheet.name)).toEqual(["Report", "Notes"]);
    expect(sheets[0].rows).toEqual([
      ["Month", "Share", "Total"],
      ["Jan", "25%", "3"],
      ["2025-12-09", "", ""],
    ]);
    expect(sheets[1].rows).toEqual([["Note"], ["Draft"]]);
  });

  it("caps a large sheet at 200 rows and 50 columns but reports its full size", () => {
    const rows = Array.from({ length: 250 }, (_, row) =>
      Array.from({ length: 60 }, (_, column) => `${row}:${column}`),
    );

    const [sheet] = readSpreadsheetPreview(workbookBytes({ Data: utils.aoa_to_sheet(rows) }));

    expect(sheet.rows).toHaveLength(200);
    expect(sheet.rows[0]).toHaveLength(50);
    expect(sheet.totalRows).toBe(250);
    expect(sheet.totalColumns).toBe(60);
  });

  it("reads only the capped columns of a sheet that declares a huge range", () => {
    const sheet = utils.aoa_to_sheet([["Name"], ["Ada"]]);
    sheet["!ref"] = "A1:XFD150";

    const bytes = workbookBytes({ Wide: sheet });
    const startedAt = performance.now();
    const [preview] = readSpreadsheetPreview(bytes);

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(preview.rows).toHaveLength(150);
    expect(preview.rows[0]).toHaveLength(50);
    expect(preview.rows[1][0]).toBe("Ada");
    expect(preview.totalColumns).toBe(16384);
  });

  it("stops at the rows actually read when the data starts below row 1", () => {
    const rows = Array.from({ length: 250 }, (_, index) => [`row ${index + 3}`]);
    const sheet = utils.aoa_to_sheet(rows, { origin: "B3" });
    sheet["!ref"] = "B3:B252";

    const [preview] = readSpreadsheetPreview(workbookBytes({ Offset: sheet }));

    // Rows 3–200 of the sheet: no blank rows past what the reader parsed.
    expect(preview.rows).toHaveLength(198);
    expect(preview.rows.at(-1)).toEqual(["row 200"]);
    expect(preview.totalRows).toBe(250);
  });

  it("shows a formula error instead of a blank cell", () => {
    const sheet = utils.aoa_to_sheet([["Ratio"], [0]]);
    sheet.A2 = { t: "e", v: 0x07, f: "1/0" };

    const [preview] = readSpreadsheetPreview(workbookBytes({ Calc: sheet }));

    expect(preview.rows[1][0]).toBe("#DIV/0!");
  });

  it("throws on a file that is not a workbook", () => {
    const zipHeaderOnly = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer;
    expect(() => readSpreadsheetPreview(zipHeaderOnly)).toThrow();
  });
});

describe("isSpreadsheetPath", () => {
  it("matches the workbook formats the preview reads", () => {
    expect(isSpreadsheetPath("projects/report.xlsx")).toBe(true);
    expect(isSpreadsheetPath("projects/legacy.XLS")).toBe(true);
    expect(isSpreadsheetPath("projects/budget.ods")).toBe(true);
    expect(isSpreadsheetPath("projects/data.csv")).toBe(false);
    expect(isSpreadsheetPath("projects/budget.numbers")).toBe(false);
  });
});
