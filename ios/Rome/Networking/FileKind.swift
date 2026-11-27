import Foundation

/// What a file previews as: the server's `fileKind`, from
/// `packages/api-types/src/file-kinds.ts`.
enum FileKind: String, Sendable {
    case text, image, video, audio, pdf, docx, binary

    /// By a file's name, for a link that carries no kind: the server's rule,
    /// by its extension. A name with no extension is text, as on the server.
    init(name: String) {
        let file = (name as NSString).lastPathComponent
        let dot = file.lastIndex(of: ".")
        guard let dot, dot > file.startIndex else { self = .text; return }
        let ext = file[file.index(after: dot)...].lowercased()
        self = Self.byExtension[ext] ?? .binary
    }

    /// What a MIME type alone says, for an older server's output; nil when it says nothing.
    init?(mimeType: String?) {
        let type = (mimeType ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        if type.hasPrefix("image/") { self = .image }
        else if type.hasPrefix("video/") { self = .video }
        else if type.hasPrefix("audio/") { self = .audio }
        else if type == "application/pdf" { self = .pdf }
        else if type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" { self = .docx }
        else if type.hasPrefix("text/") || type == "application/json" { self = .text }
        else { return nil }
    }

    /// The server's extensions for each kind, without the dot. Kept equal to
    /// file-kinds.ts by `FileKindTests`.
    static let extensions: [(FileKind, [String])] = [
        (.image, [
            "apng", "avif", "gif", "jpeg", "jpg", "png", "svg", "webp",
        ]),
        (.video, [
            "mov", "mp4", "m4v", "ogv", "webm",
        ]),
        (.audio, [
            "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba",
        ]),
        (.pdf, [
            "pdf",
        ]),
        (.docx, [
            "docx",
        ]),
        (.text, [
            "bash", "bat", "c", "cc", "cfg", "cjs", "conf", "cpp", "css", "cs", "cts", "cxx", "csv",
            "dart", "dockerfile", "env", "erl", "ex", "exs", "fish", "go", "gradle", "graphql", "h",
            "hpp", "html", "htm", "ini", "ipynb", "java", "js", "json", "jsonl", "jsx", "kt", "kts",
            "less", "log", "lua", "markdown", "md", "mdx", "mjs", "mts", "php", "pl", "pm", "proto", "ps1", "py",
            "pyi", "r", "rb", "rs", "sass", "scala", "scss", "sh", "sql", "svelte", "swift", "toml",
            "txt", "ts", "tsx", "vue", "xml", "yaml", "yml", "zsh",
        ]),
    ]

    private static let byExtension: [String: FileKind] = {
        var map: [String: FileKind] = [:]
        for (kind, list) in extensions { for ext in list where map[ext] == nil { map[ext] = kind } }
        return map
    }()
}
