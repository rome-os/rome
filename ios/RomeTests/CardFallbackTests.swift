import Foundation
import Testing
@testable import Rome

private func parts(_ items: [[String: Any]]) -> [MessagePart] {
    MessagePart.parse(String(data: try! JSONSerialization.data(withJSONObject: items), encoding: .utf8)!)
}

private func rows(_ items: [[String: Any]]) -> [TranscriptRow] {
    let content = String(data: try! JSONSerialization.data(withJSONObject: items), encoding: .utf8)!
    let message = ChatMessage(id: "m", sessionId: "s", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)))
    return TranscriptBuilder.rows(messages: [message], pending: [], answers: [:], options: .init())
        .filter { if case .separator = $0 { return false } else { return true } }
}

/// Which parts the phone hides, which get the row that opens the web, and what that row says.
@Suite struct CardFallbackTests {
    @Test func partsTheWebHidesStayHidden() {
        let hidden = ["tool_use", "tool_result", "thinking", "result", "session_init", "system_input",
                      "subagent_start", "subagent_result", "reply_to", "handoff", "submission_card"]
        let parsed = parts(hidden.map { ["type": $0] } + [["type": "interaction_result", "toolUseId": "q", "output": [:]]])
        #expect(parsed.allSatisfy { !$0.isVisible })
        #expect(rows(hidden.map { ["type": $0] }).isEmpty)
    }

    @Test func cardsTheWebDrawsGetANamedRow() {
        let parsed = parts([
            ["type": "pending_interaction", "toolUseId": "a", "appId": "rome", "render": ["componentId": "ai-tools-card", "builtin": true]],
            ["type": "pending_interaction", "toolUseId": "b", "appId": "connector", "render": ["componentId": "connect-card", "props": ["toolkit": "gmail"]]],
            ["type": "pending_interaction", "toolUseId": "c", "appId": "connector", "render": ["componentId": "login-card"]],
            ["type": "pending_interaction", "toolUseId": "d", "appId": "habits", "render": ["componentId": "streak"]],
            ["type": "turn_recap", "turnId": "t", "content": "Done"],
            ["type": "quota_switch", "from": "claude", "to": "codex", "model": "GPT-5"],
        ])
        #expect(parsed == [
            .webOnly(.aiTools, toolUseId: "a"), .webOnly(.connectService, toolUseId: "b"), .webOnly(.connectorSignIn, toolUseId: "c"),
            .webOnly(.app("habits"), toolUseId: "d"), .webOnly(.turnSummary), .webOnly(.modelSwitch(model: "GPT-5")),
        ])
        #expect(MessagePart.WebOnlyKind.aiTools.title() == "Connect Claude or ChatGPT")
        #expect(MessagePart.WebOnlyKind.connectService.title() == "A card to connect a service")
        #expect(MessagePart.WebOnlyKind.app("habits").title(appName: "Habits") == "A card from Habits")
        #expect(MessagePart.WebOnlyKind.app("habits").title() == "An app card")
        #expect(MessagePart.WebOnlyKind.modelSwitch(model: "GPT-5").title() == "Switched to GPT-5")
    }

    /// An answered interactive card says it is done; an open one still asks to be opened.
    @Test func anAnsweredCardSaysDone() {
        let card: [String: Any] = ["type": "pending_interaction", "toolUseId": "tu-1", "appId": "connector", "render": ["componentId": "connect-card"]]
        let content = String(data: try! JSONSerialization.data(withJSONObject: [card]), encoding: .utf8)!
        let message = ChatMessage(id: "m", sessionId: "s", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)))
        func row(_ answers: [String: JSONValue]) -> TranscriptRow? {
            TranscriptBuilder.rows(messages: [message], pending: [], answers: answers, options: .init()).last
        }
        #expect(row([:]) == .webOnly(id: "m:0", kind: .connectService, done: false))
        #expect(row(["tu-1": .object(["connected": .bool(true)])]) == .webOnly(id: "m:0", kind: .connectService, done: true))
        #expect(row(["other": .object([:])]) == .webOnly(id: "m:0", kind: .connectService, done: false))
    }

    /// A newer server's part this build does not know is a row, not a gap.
    @Test func anUnknownPartIsJustACard() {
        #expect(parts([["type": "poll_card", "question": "?"]]) == [.webOnly(.unknown)])
        #expect(rows([["type": "poll_card"]]) == [.webOnly(id: "m:0", kind: .unknown)])
        #expect(MessagePart.WebOnlyKind.unknown.title() == "A card")
    }
}

@Suite struct RoutineCardTests {
    private func draft(_ trigger: String, key: String? = "chat-routine:1", preview: [String: Any]? = nil, filter: String? = nil) -> MessagePart.RoutineDraftPart {
        var spec: [String: Any] = [
            "name": "Friday digest", "sentence": "Every Friday, Rome sends you a digest.",
            "watchLabel": trigger == "manual" ? "" : "Every Friday at 9:00 AM",
            "thenSummary": "summarize the week", "trigger": ["type": trigger], "actionName": "digest", "args": [:],
        ]
        if let preview { spec["preview"] = preview }
        if let filter { spec["filterSummary"] = filter }
        var part: [String: Any] = ["type": "routine_draft_card", "toolUseId": "t1", "draft": spec]
        if let key { part["routineKey"] = key }
        guard case .routineDraft(let parsed) = parts([part]).first else { fatalError("no routine card") }
        return parsed
    }

    @Test func aRoutineCardSaysWhenItRunsAndWhatItDoes() {
        let schedule = draft("schedule")
        #expect(schedule.name == "Friday digest")
        #expect(schedule.routineKey == "chat-routine:1")
        #expect(RoutineCardText.kind(schedule.trigger) == "Scheduled routine")
        #expect(RoutineCardText.rows(schedule) == [
            .init(label: "Runs", value: "Every Friday at 9:00 AM"),
            .init(label: "Then", value: "summarize the week"),
        ])
        let event = draft("event_bus", preview: ["kind": "generic", "title": "Text you on Telegram"], filter: "sender is dana@example.com")
        #expect(RoutineCardText.kind(event.trigger) == "Event routine")
        #expect(RoutineCardText.rows(event) == [
            .init(label: "Watches", value: "Every Friday at 9:00 AM"),
            .init(label: "Only when", value: "sender is dana@example.com"),
            .init(label: "Then", value: "Text you on Telegram"),
        ])
        let manual = draft("manual")
        #expect(RoutineCardText.kind(manual.trigger) == "Manual routine")
        #expect(RoutineCardText.rows(manual).first == .init(label: "Runs", value: "When you run it"))
    }

    /// The card finds its routine as the dashboard's does: by key, else by name among keyless routines.
    @Test func theStatusComesFromTheRoutineTheCardMade() {
        let keyed = draft("schedule")
        let routines = [
            RoutineRef(id: "r1", name: "Friday digest", key: nil, enabled: true),
            RoutineRef(id: "r2", name: "Other", key: "chat-routine:1", enabled: false),
        ]
        #expect(RoutineStatus.find(keyed, in: routines) == .paused(routineId: "r2"))
        #expect(RoutineStatus.find(keyed, in: [routines[0]]) == .notOn)
        let legacy = draft("schedule", key: nil)
        #expect(RoutineStatus.find(legacy, in: routines) == .on(routineId: "r1"))
        // A missing `enabled` reads as on, as the dashboard reads it.
        #expect(RoutineStatus.find(legacy, in: [RoutineRef(id: "r3", name: "Friday digest")]) == .on(routineId: "r3"))
        // A keyed routine never matches a legacy card by name.
        #expect(RoutineStatus.find(legacy, in: [RoutineRef(id: "r4", name: "Friday digest", key: "chat-routine:9")]) == .notOn)

        #expect(RoutineCardText.status(.notOn) == "Not on")
        #expect(RoutineCardText.status(.on(routineId: "r")) == "On")
        #expect(RoutineCardText.status(.paused(routineId: "r")) == "Paused")
        #expect(RoutineCardText.link(nil) == "Turn it on on the web")
        #expect(RoutineCardText.link(.notOn) == "Turn it on on the web")
        #expect(RoutineCardText.link(.on(routineId: "r")) == "Open in Routines")
    }

    /// An unsaved proposal is turned on from its own card, so the link opens
    /// that card's chat; Routines cannot turn it on. A saved routine opens its page.
    @Test func theLinkGoesWhereTheRoutineCanBeTurnedOn() {
        let origin = URL(string: "https://me.romeos.cc")!
        #expect(RoutineCardText.destination(.notOn, origin: origin, sessionId: "topic-1", mainChatServerID: nil).absoluteString == "https://me.romeos.cc/chat/topic-1")
        #expect(RoutineCardText.destination(nil, origin: origin, sessionId: conciergeChatID, mainChatServerID: "c-42").absoluteString == "https://me.romeos.cc/chat/c-42")
        #expect(RoutineCardText.destination(.paused(routineId: "r2"), origin: origin, sessionId: "topic-1", mainChatServerID: nil).absoluteString == "https://me.romeos.cc/routines/r2")
    }

    @MainActor
    @Test func aStatusThatCannotBeReadIsLeftOut() async {
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: FakeBackend())
        await store.loadRoutines()
        #expect(store.routineStatus(draft("schedule")) == nil)
    }
}

/// Dashboard pages open in the app's web view, which tells the dashboard it is the app.
@Suite struct InstancePageTests {
    let origin = URL(string: "https://me.romeos.cc")!

    @Test func pagesTheAppOpens() {
        #expect(InstancePages.connections(origin: origin).absoluteString == "https://me.romeos.cc/settings/connections")
        #expect(InstancePages.routines(origin: origin).absoluteString == "https://me.romeos.cc/routines")
        #expect(InstancePages.routines(origin: origin, routineId: "r1").absoluteString == "https://me.romeos.cc/routines/r1")
        #expect(InstancePages.chat(origin: origin, sessionId: "c1").absoluteString == "https://me.romeos.cc/chat/c1")
    }

    @Test func theUserAgentNamesTheApp() {
        #expect(InstancePages.applicationName(webKitDefault: "Mobile/15E148", version: "1.0.0") == "Mobile/15E148 RomeiOS/1.0.0")
        #expect(InstancePages.applicationName(webKitDefault: nil, version: "1.0.0") == "RomeiOS/1.0.0")
    }

    @MainActor
    @Test func theOpenerHandsThePageToTheStack() {
        var opened: [URL] = []
        let action = OpenInstancePageAction { opened.append($0) }
        action(InstancePages.routines(origin: origin))
        #expect(opened == [URL(string: "https://me.romeos.cc/routines")!])
    }
}
