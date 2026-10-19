type ClipboardFileItem = {
  kind: string;
  getAsFile?: () => File | null;
};

type ClipboardFileSource = {
  files?: Iterable<File> | ArrayLike<File> | null;
  items?: Iterable<ClipboardFileItem> | ArrayLike<ClipboardFileItem> | null;
  types?: Iterable<string> | ArrayLike<string> | null;
};

function toArray<T>(value: Iterable<T> | ArrayLike<T> | null | undefined): T[] {
  return value ? Array.from(value) : [];
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  const knownExtensions: Record<string, string> = {
    "application/json": "json",
    "application/pdf": "pdf",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/csv": "csv",
    "text/html": "html",
    "text/markdown": "md",
    "text/plain": "txt",
  };

  if (knownExtensions[normalized]) {
    return knownExtensions[normalized];
  }

  const subtype = normalized.match(/^[\w.-]+\/([\w.+-]+)$/)?.[1];
  if (!subtype) {
    return "bin";
  }

  return subtype.includes("+") ? subtype.split("+").at(-1) || "bin" : subtype;
}

function ensureClipboardFileName(file: File, index: number): File {
  if (file.name.trim()) {
    return file;
  }

  return new File([file], `pasted-file-${index + 1}.${extensionForMimeType(file.type)}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

export function extractFilesFromDataTransfer(source: ClipboardFileSource): File[] {
  const directFiles = toArray(source.files);
  if (directFiles.length > 0) {
    return directFiles;
  }

  return toArray(source.items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile?.();
    return file ? [file] : [];
  });
}

// A pasted screenshot or clipboard blob often arrives with an empty name.
export function extractFilesFromClipboard(source: ClipboardFileSource): File[] {
  return extractFilesFromDataTransfer(source).map(ensureClipboardFileName);
}

export function dataTransferHasFiles(source: ClipboardFileSource): boolean {
  if (toArray(source.types).includes("Files")) {
    return true;
  }
  if (toArray(source.files).length > 0) {
    return true;
  }
  return toArray(source.items).some((item) => item.kind === "file");
}
