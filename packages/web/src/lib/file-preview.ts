export type TextPreviewKind = "markdown" | "delimited" | "html";

export function getFileExtension(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
}

export function getTextPreviewKind(path: string, mimeType: string): TextPreviewKind | null {
  const extension = getFileExtension(path);
  if (extension === "md" || extension === "mdx" || mimeType === "text/markdown") {
    return "markdown";
  }

  if (extension === "html" || extension === "htm" || mimeType === "text/html") {
    return "html";
  }

  if (
    extension === "csv" ||
    extension === "tsv" ||
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values"
  ) {
    return "delimited";
  }

  return null;
}

export function getDelimitedSeparator(path: string, mimeType: string): "," | "\t" {
  const extension = getFileExtension(path);
  return extension === "tsv" || mimeType === "text/tab-separated-values" ? "\t" : ",";
}

const MAX_DELIMITED_COLUMNS = 50;
const MAX_DELIMITED_ROWS = 200;

export function parseDelimitedContent(content: string, separator: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === separator && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row.slice(0, MAX_DELIMITED_COLUMNS));
      if (rows.length >= MAX_DELIMITED_ROWS) {
        return rows;
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row.slice(0, MAX_DELIMITED_COLUMNS));
  }

  return rows;
}
