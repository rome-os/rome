import Foundation
import Testing
@testable import Rome

private let outputsJSON = #"""
{"outputs":[
 {"id":"o1","kind":"written","name":"kyoto-trip_plan.md","path":"/data/projects/p/kyoto-trip_plan.md","link":"/projects/p/kyoto-trip_plan.md","links":["/projects/p/kyoto-trip_plan.md"],"mimeType":"text/markdown","at":"2026-11-17T09:00:00.000Z","turnId":"t1","messageId":null,"missing":false,"from":null,"contentUrl":"/api/chat/sessions/c1/outputs/o1/content"},
 {"id":"o2","kind":"shown","name":"hotel.jpg","path":"/api/assets/abc.jpg","link":"/api/assets/abc.jpg","mimeType":"image/jpeg","at":"2026-11-16T09:00:00.000Z","turnId":null,"messageId":"m1","missing":false,"from":{"chatId":"task-1","name":"Book a hotel"},"contentUrl":"/api/chat/sessions/c1/outputs/o2/content"},
 {"id":"o3","kind":"written","name":"gone.py","path":"/x/gone.py","link":null,"mimeType":null,"at":"2026-11-15T09:00:00.000Z","turnId":null,"messageId":null,"missing":true,"from":null,"contentUrl":null},
 {"id":"broken"}
],"indexing":true}
"""#

/// The Agent page's Outputs tab (docs/domains/chats.md#outputs).
@MainActor
@Suite struct ChatOutputsTests {
    private func decoded() throws -> ChatOutputsResponse {
        try JSONDecoder().decode(ChatOutputsResponse.self, from: Data(outputsJSON.utf8))
    }

    @Test func theListDecodesAndDropsARowItCannotRead() throws {
        let response = try decoded()
        #expect(response.outputs.map(\.id) == ["o1", "o2", "o3"])
        #expect(response.indexing)
        #expect(response.outputs[1].from == ChatOutput.Source(chatId: "task-1", name: "Book a hotel"))
        #expect(response.outputs[2].contentUrl == nil)
    }

    @Test func aServerWithoutIndexingReadsAsDone() throws {
        let response = try JSONDecoder().decode(ChatOutputsResponse.self, from: Data(#"{"outputs":[]}"#.utf8))
        #expect(!response.indexing)
    }

    @Test func aRowNamesTheFileAsTheWebDoes() throws {
        let outputs = try decoded().outputs
        #expect(outputs[0].title == "Kyoto trip plan")
        #expect(outputs[0].type == .document)
        #expect(outputs[1].type == .picture)
        #expect(outputs[2].type == .code)
        #expect(ChatOutputType(name: "prices.csv", kind: .text) == .spreadsheet)
        #expect(ChatOutputType(name: "index.html", kind: .text) == .page)
        #expect(ChatOutputType(name: "archive.zip", kind: .binary) == .file)
        #expect(ChatOutputType(name: "voice-note.wav", kind: .audio) == .audio)
        #expect(ChatOutputType(name: "clip.mp4", kind: .video) == .video)
        #expect(ChatOutputType(name: "slides.pptx", kind: .binary) == .document)
        #expect(ChatOutputType(name: "fix.diff", kind: .text) == .code)
        #expect(ChatOutputType(name: "build.cjs", kind: .text) == .code)
    }

    @Test func aRowSaysWhereTheFileCameFrom() throws {
        let outputs = try decoded().outputs
        #expect(outputs[0].sourceLine == String(localized: "Written"))
        #expect(outputs[1].sourceLine == String(localized: "from \("Book a hotel")"))
        #expect(outputs[2].sourceLine == String(localized: "Moved or deleted"))
    }

    @Test func anOutputOpensAsAChatLinkToItDoes() {
        func output(_ name: String, _ mime: String?, kind: String? = nil) -> ChatOutput {
            ChatOutput(id: name, kind: "written", name: name, link: nil, mimeType: mime, fileKind: kind, at: "", missing: false, from: nil, contentUrl: "/api/chat/sessions/c1/outputs/\(name)/content")
        }
        #expect(output("page.html", "text/html", kind: "text").linkedFile?.opening == .share)
        #expect(output("logo.svg", "image/svg+xml", kind: "image").linkedFile?.opening == .share)
        #expect(!output("logo.svg", "image/svg+xml").isPicture)
        #expect(output("report.pdf", "application/pdf", kind: "pdf").linkedFile?.opening == .preview)
        #expect(output("photo.png", "image/png").isPicture)
        #expect(output("clip.mp4", "video/mp4", kind: "video").linkedFile?.opening == .media)
        #expect(output("song.mp3", "audio/mpeg").linkedFile?.opening == .media)
        // The server's kind wins over a MIME type that says nothing.
        #expect(output("clip", nil, kind: "video").type == .video)
        #expect(output("clip.mp4", "video/mp4").linkedFile?.apiPath == "/chat/sessions/c1/outputs/clip.mp4/content")
        var gone = output("gone.mp4", "video/mp4")
        gone.missing = true
        #expect(gone.linkedFile == nil)
    }

    @Test func aChatLinkOpensByItsName() {
        #expect(LinkedFile(apiPath: "/assets/a.mp4", query: nil, name: "a.mp4").opening == .media)
        #expect(LinkedFile(apiPath: "/assets/a.m4a", query: nil, name: "a.m4a").opening == .media)
        #expect(LinkedFile(apiPath: "/assets/a.png", query: nil, name: "a.png").opening == .picture)
        #expect(LinkedFile(apiPath: "/assets/a.docx", query: nil, name: "a.docx").opening == .preview)
        #expect(LinkedFile(apiPath: "/assets/a.html", query: nil, name: "a.html").opening == .share)
        #expect(LinkedFile(apiPath: "/projects/download", query: "path=projects/a.mp4", name: "a.mp4").streamPath == "/projects/asset")
        #expect(LinkedFile(apiPath: "/assets/a.mp4", query: nil, name: "a.mp4").streamPath == "/assets/a.mp4")
        #expect(FileKind(name: "a.docx") == .docx)
        #expect(FileKind(name: "Makefile") == .text)
    }

    @Test func todayIsTheDeviceCalendarsDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = try #require(RomeDate.parse("2026-11-17T20:00:00.000Z"))
        let outputs = try decoded().outputs
        #expect(AgentOutputsView.isToday(outputs[0], now: now, calendar: calendar))
        #expect(!AgentOutputsView.isToday(outputs[1], now: now, calendar: calendar))
    }

    @Test func theStoreReadsTheChatsOutputs() async {
        let store = ChatOutputsStore(chatId: conciergeChatID, backend: DemoBackend())
        await store.load()
        #expect(store.loaded)
        #expect(!store.outputs.isEmpty)
        #expect(store.outputs.contains { $0.from != nil })
    }

    @Test func aBlankTopicChatHasNoOutputsList() {
        let drafts = DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-outputs-\(UUID().uuidString)/Drafts"), instance: "t")
        let workspace = Workspace(backend: FakeBackend(), instanceName: "T", host: "t", accountLabel: "t", drafts: drafts)
        #expect(workspace.outputs(forChat: "") == nil)
    }
}
