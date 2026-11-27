// What kind of file a name is, by its extension: the one rule the server, the
// dashboard and the iOS app's wire field `fileKind` share. The projects
// viewer, chat's inline media and a chat's Outputs tab all preview by it.
// docs/domains/chats.md#outputs

/** What a file previews as. */
export type FileKind = "text" | "image" | "video" | "audio" | "pdf" | "docx" | "binary";

export interface FileDescriptor {
  editable: boolean;
  kind: FileKind;
  mimeType: string;
}

const IMAGE_MIME_TYPES = new Map<string, string>([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const VIDEO_MIME_TYPES = new Map<string, string>([
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
]);

const AUDIO_MIME_TYPES = new Map<string, string>([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".weba", "audio/webm"],
]);

const PDF_MIME_TYPES = new Map<string, string>([[".pdf", "application/pdf"]]);

const DOCX_MIME_TYPES = new Map<string, string>([
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
]);

const TEXT_MIME_TYPES = new Map<string, string>([
  [".bash", "text/x-shellscript"],
  [".bat", "text/plain"],
  [".c", "text/x-c"],
  [".cc", "text/x-c"],
  [".cfg", "text/plain"],
  [".cjs", "text/javascript"],
  [".conf", "text/plain"],
  [".cpp", "text/x-c"],
  [".css", "text/css"],
  [".cs", "text/x-csharp"],
  [".cts", "text/typescript"],
  [".cxx", "text/x-c"],
  [".csv", "text/csv"],
  [".dart", "text/plain"],
  [".dockerfile", "text/plain"],
  [".env", "text/plain"],
  [".erl", "text/plain"],
  [".ex", "text/plain"],
  [".exs", "text/plain"],
  [".fish", "text/x-shellscript"],
  [".go", "text/x-go"],
  [".gradle", "text/plain"],
  [".graphql", "application/graphql-response+json"],
  [".h", "text/x-c"],
  [".hpp", "text/x-c"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".ini", "text/plain"],
  [".ipynb", "application/json"],
  [".java", "text/x-java-source"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".jsx", "text/javascript"],
  [".kt", "text/plain"],
  [".kts", "text/plain"],
  [".less", "text/css"],
  [".log", "text/plain"],
  [".lua", "text/plain"],
  [".md", "text/markdown"],
  [".mdx", "text/mdx"],
  [".mjs", "text/javascript"],
  [".mts", "text/typescript"],
  [".php", "application/x-httpd-php"],
  [".pl", "text/plain"],
  [".pm", "text/plain"],
  [".proto", "text/plain"],
  [".ps1", "text/plain"],
  [".py", "text/x-python"],
  [".pyi", "text/x-python"],
  [".r", "text/plain"],
  [".rb", "text/x-ruby"],
  [".rs", "text/plain"],
  [".sass", "text/css"],
  [".scala", "text/plain"],
  [".scss", "text/css"],
  [".sh", "text/plain"],
  [".sql", "application/sql"],
  [".svelte", "text/plain"],
  [".swift", "text/plain"],
  [".toml", "application/toml"],
  [".txt", "text/plain"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".vue", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".zsh", "text/x-shellscript"],
]);

const MIME_TABLES: [ReadonlyMap<string, string>, FileKind][] = [
  [IMAGE_MIME_TYPES, "image"],
  [VIDEO_MIME_TYPES, "video"],
  [AUDIO_MIME_TYPES, "audio"],
  [PDF_MIME_TYPES, "pdf"],
  [DOCX_MIME_TYPES, "docx"],
  [TEXT_MIME_TYPES, "text"],
];

/** The extension of a path's last segment, dot included and lower-cased; "" for none or a dotfile. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** A file's kind and type by its name. A name with no extension is text. */
export function describeFile(path: string): FileDescriptor {
  const extension = extensionOf(path);
  const imageMimeType = IMAGE_MIME_TYPES.get(extension);
  if (imageMimeType) return { kind: "image", mimeType: imageMimeType, editable: false };
  const videoMimeType = VIDEO_MIME_TYPES.get(extension);
  if (videoMimeType) return { kind: "video", mimeType: videoMimeType, editable: false };
  const audioMimeType = AUDIO_MIME_TYPES.get(extension);
  if (audioMimeType) return { kind: "audio", mimeType: audioMimeType, editable: false };
  const pdfMimeType = PDF_MIME_TYPES.get(extension);
  if (pdfMimeType) return { kind: "pdf", mimeType: pdfMimeType, editable: false };
  const docxMimeType = DOCX_MIME_TYPES.get(extension);
  if (docxMimeType) return { kind: "docx", mimeType: docxMimeType, editable: false };
  const textMimeType = TEXT_MIME_TYPES.get(extension);
  if (textMimeType) return { kind: "text", mimeType: textMimeType, editable: true };
  if (extension === "")
    return { kind: "text", mimeType: "text/plain; charset=utf-8", editable: true };
  return { kind: "binary", mimeType: "application/octet-stream", editable: false };
}

/**
 * The kind a MIME type alone says, for a record that names no `fileKind`
 * (an older server's): null when the type says nothing.
 */
export function fileKindOfMimeType(mimeType: string | null | undefined): FileKind | null {
  const type = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type) return null;
  for (const [table, kind] of MIME_TABLES) {
    for (const known of table.values()) if (known === type) return kind;
  }
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("text/")) return "text";
  return null;
}
