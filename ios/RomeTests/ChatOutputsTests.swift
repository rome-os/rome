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
        #expect(ChatOutputType(name: "prices.csv", mimeType: "text/csv") == .spreadsheet)
        #expect(ChatOutputType(name: "index.html", mimeType: "text/html") == .page)
        #expect(ChatOutputType(name: "archive.zip", mimeType: nil) == .file)
        #expect(ChatOutputType(name: "voice-note.wav", mimeType: "audio/wav") == .audio)
        #expect(ChatOutputType(name: "clip.mp4", mimeType: "video/mp4") == .video)
        #expect(ChatOutputType(name: "slides.pptx", mimeType: nil) == .document)
        #expect(ChatOutputType(name: "fix.diff", mimeType: nil) == .code)
        #expect(ChatOutputType(name: "build.cjs", mimeType: "text/javascript") == .code)
    }

    @Test func aRowSaysWhereTheFileCameFrom() throws {
        let outputs = try decoded().outputs
        #expect(outputs[0].sourceLine == String(localized: "Written"))
        #expect(outputs[1].sourceLine == String(localized: "from \("Book a hotel")"))
        #expect(outputs[2].sourceLine == String(localized: "Moved or deleted"))
    }

    @Test func nothingThatWouldRunOpensInAPreview() {
        func output(_ name: String, _ mime: String?) -> ChatOutput {
            ChatOutput(id: name, kind: "written", name: name, link: nil, mimeType: mime, at: "", missing: false, from: nil, contentUrl: "/api/x")
        }
        #expect(output("page.html", "text/html").sharesOnly)
        #expect(output("logo.svg", "image/svg+xml").sharesOnly)
        #expect(!output("logo.svg", "image/svg+xml").isPicture)
        #expect(!output("report.pdf", "application/pdf").sharesOnly)
        #expect(output("photo.png", "image/png").isPicture)
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
