import Foundation
import Testing
@testable import Rome

/// The phone sorts a linked file by the server's rule, never the system's
/// types: `.ts` is TypeScript there, not an MPEG transport stream.
@Suite struct FileKindTests {
    @Test func theTableMatchesTheServers() throws {
        let source = URL(filePath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "packages/api-types/src/file-kinds.ts")
        let text = try String(contentsOf: source, encoding: .utf8)
        let names: [FileKind: String] = [.image: "IMAGE", .video: "VIDEO", .audio: "AUDIO", .pdf: "PDF", .docx: "DOCX", .text: "TEXT"]
        for (kind, mine) in FileKind.extensions {
            let name = try #require(names[kind])
            let start = try #require(text.range(of: "const \(name)_MIME_TYPES"))
            let end = try #require(text.range(of: "]);", range: start.upperBound..<text.endIndex))
            let block = text[start.upperBound..<end.lowerBound]
            let theirs = block.matches(of: /\["\.([a-z0-9]+)"/).map { String($0.1) }
            #expect(mine == theirs, "\(kind)")
        }
        #expect(FileKind.extensions.count == names.count)
    }

    @Test func codeIsText() {
        #expect(FileKind(name: "packages/core/src/index.ts") == .text)
        #expect(FileKind(name: "a.mts") == .text)
        #expect(FileKind(name: "App.tsx") == .text)
        #expect(LinkedFile(apiPath: "/projects/download", query: "path=projects/a.ts", name: "a.ts").opening == .preview)
    }

    @Test func namesWithoutAKnownExtension() {
        #expect(FileKind(name: "Makefile") == .text)
        #expect(FileKind(name: ".bashrc") == .text)
        #expect(FileKind(name: "bundle.zip") == .binary)
        #expect(FileKind(name: "CLIP.MP4") == .video)
    }
}
