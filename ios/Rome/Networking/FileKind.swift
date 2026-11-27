import Foundation
import UniformTypeIdentifiers

/// What a file previews as: the server's `fileKind`, from
/// `packages/api-types/src/file-kinds.ts`.
enum FileKind: String, Sendable {
    case text, image, video, audio, pdf, docx, binary

    /// By a file's name, for a link that carries no kind: the system's type
    /// for its extension. A name with no extension is text, as on the server.
    init(name: String) {
        let ext = (name as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { self = .text; return }
        if ext == "docx" { self = .docx; return }
        guard let type = UTType(filenameExtension: ext) else { self = .binary; return }
        if type.conforms(to: .image) { self = .image }
        else if type.conforms(to: .audio) { self = .audio }
        else if type.conforms(to: .movie) { self = .video }
        else if type.conforms(to: .pdf) { self = .pdf }
        else if type.conforms(to: .text) || type.conforms(to: .sourceCode) { self = .text }
        else { self = .binary }
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
}
