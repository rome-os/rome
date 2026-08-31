import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Badge } from "./badge.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.js";

afterEach(cleanup);

describe("Table", () => {
  it("keeps a Badge from taking a control height and setting its table row height", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>
              <Badge>ready</Badge>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const row = screen.getByRole("row");
    const cell = screen.getByRole("cell");
    const badge = screen.getByText("ready");
    const heightClasses = [...badge.classList].filter((token) => token.startsWith("h-"));

    expect(row.contains(cell)).toBe(true);
    expect(cell.contains(badge)).toBe(true);
    for (const element of [row, cell, badge]) {
      expect([...element.classList].some((token) => token.includes("--control-h-"))).toBe(false);
    }
    expect(heightClasses).toEqual(["h-[var(--badge-h)]"]);
  });

  it("uses Auxiliary typography for header cells", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );

    const header = screen.getByRole("columnheader", { name: "Status" });
    expect(header.classList).toContain("text-aux");
    expect(header.classList).not.toContain("font-medium");
  });
});
