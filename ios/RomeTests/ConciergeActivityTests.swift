import Foundation
import Testing
@testable import Rome

/// The header's status line, read leniently from what the server sends.
@MainActor
@Suite struct ConciergeActivityTests {
    private func activity(_ json: String) -> ConciergeActivity? {
        (try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))).flatMap(ConciergeActivity.init(json:))
    }

    @Test func eachStateIsRead() {
        #expect(activity(#"{"kind":"idle"}"#) == .idle)
        #expect(activity(#"{"kind":"needsYou"}"#) == .needsYou)
        #expect(activity(#"{"kind":"working"}"#) == .working)
        #expect(activity(#"{"kind":"tool","tool":"searchingWeb"}"#) == .tool(.searchingWeb))
        #expect(activity(#"{"kind":"tasks","title":"Weekly notes","more":2}"#) == .tasks(title: "Weekly notes", more: 2))
    }

    /// A newer server's values: an unknown kind shows nothing, an unknown tool reads as working.
    @Test func unknownValuesAreLenient() {
        #expect(activity(#"{"kind":"dreaming"}"#) == nil)
        #expect(activity(#"{}"#) == nil)
        #expect(activity(#"{"kind":"tool","tool":"paintingPictures"}"#) == .working)
        #expect(activity(#"{"kind":"tool"}"#) == .working)
    }

    @Test func theLineReadsAsTheTableSays() {
        #expect(ConciergeActivity.idle.statusLine == nil)
        #expect(ConciergeActivity.needsYou.statusLine == "Waiting for your answer")
        #expect(ConciergeActivity.working.statusLine == "Working on it")
        #expect(ConciergeActivity.tool(.readingPage).statusLine == "Reading a page")
        #expect(ConciergeActivity.tasks(title: "Weekly notes", more: 0).statusLine == "Weekly notes")
        #expect(ConciergeActivity.tasks(title: "Weekly notes", more: 2).statusLine == "Weekly notes +2")
        #expect(ConciergeActivity.Tool.allCases.allSatisfy { ConciergeActivity.tool($0).statusLine?.isEmpty == false })
        let busy: [ConciergeActivity] = [.working, .tool(.readingChat), .tasks(title: "t", more: 0)]
        let quiet: [ConciergeActivity] = [.idle, .needsYou]
        #expect(busy.map(\.isBusy) == [true, true, true])
        #expect(quiet.map(\.isBusy) == [false, false])
    }

    /// An older instance sends no `activity`: no line. An unknown one is dropped, the chat kept.
    @Test func theChatListCarriesItOrNot() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ConciergeChat.self, from: Data(json.utf8)) }
        #expect(try decode(#"{"id":"c","name":"","main":true}"#).activity == nil)
        #expect(try decode(#"{"id":"c","name":"","main":true,"activity":{"kind":"needsYou"}}"#).activity == .needsYou)
        #expect(try decode(#"{"id":"c","name":"","main":true,"activity":{"kind":"later"}}"#).activity == nil)
        let kept = ConciergeChat(id: "c", name: "", main: true, unread: 1, activity: .tasks(title: "t", more: 1))
        #expect(try JSONDecoder().decode(ConciergeChat.self, from: try JSONEncoder().encode(kept)) == kept)
    }

    @Test func theEventIsRead() {
        guard case .conciergeActivity(let chat, let state) = LiveEventsSocket.decode(name: "concierge_activity", data: .object(["chatId": .string("c1"), "activity": .object(["kind": .string("working")]), "at": .number(1)])) else {
            Issue.record("not read"); return
        }
        #expect(chat == "c1" && state == .working)
        guard case .conciergeActivity(_, let unknown) = LiveEventsSocket.decode(name: "concierge_activity", data: .object(["chatId": .string("c1"), "activity": .object(["kind": .string("later")])])) else {
            Issue.record("not read"); return
        }
        #expect(unknown == nil)
    }

    /// Each chat keeps its own state; the list seeds it, events move it, idle and unknown show nothing.
    @Test func eventsMergePerChat() async {
        let backend = FakeBackend()
        backend.topicChats = [ConciergeChat(id: "t1", name: "Trip", main: false, unread: 0, activity: .tasks(title: "Hotels", more: 0))]
        let store = TopicChatsStore(backend: backend)
        store.start()
        for _ in 0..<50 where store.activity(for: "t1") == nil { try? await Task.sleep(for: .milliseconds(10)) }
        #expect(store.activity(for: "t1") == .tasks(title: "Hotels", more: 0))
        backend.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "main", activity: .needsYou))
        backend.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "t1", activity: .working))
        #expect(store.activity(for: "main") == .needsYou)
        #expect(store.activity(for: "t1") == .working)
        backend.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "t1", activity: .idle))
        #expect(store.activity(for: "t1") == nil)
        backend.bus.emit(LiveTopic.conciergeActivity, .conciergeActivity(chatId: "main", activity: nil))
        #expect(store.activity(for: "main") == nil)
        #expect(store.activity(for: nil) == nil)
        store.stop()
    }
}
