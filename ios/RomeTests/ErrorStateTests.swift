import Foundation
import Testing
@testable import Rome

private func json(_ parts: [[String: Any]]) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: parts), encoding: .utf8)!
}

private func message(
    _ id: String,
    role: String = "assistant",
    turn: String? = nil,
    _ parts: [[String: Any]] = [],
    at seconds: TimeInterval,
    trace: TraceSummary? = nil,
    inputState: String? = nil,
    reaction: String? = nil
) -> ChatMessage {
    var message = ChatMessage(id: id, sessionId: "concierge", turnId: turn, role: role, content: json(parts), createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + seconds)), traceSummary: trace)
    message.inputState = inputState
    message.statusReaction = reaction
    return message
}

@Suite struct SendFailureTests {
    @Test func readsWhyASendFailed() {
        #expect(SendFailure(APIError.offline) == .offline)
        #expect(SendFailure(APIError.network) == .unreachable)
        #expect(SendFailure(APIError.unauthorized) == .sessionExpired)
        #expect(SendFailure(APIError.notFound) == .notFound)
        #expect(SendFailure(APIError.conciergeOff) == .chatOff)
        #expect(SendFailure(APIError.server(status: 409, message: "This chat is archived and read-only")) == .archived)
        #expect(SendFailure(APIError.server(status: 503, message: nil)) == .unreachable)
        #expect(SendFailure(APIError.server(status: 500, message: "boom")) == .serverError)
        #expect(SendFailure(APIError.server(status: 400, message: "inputId must be a UUID")) == .rejected("inputId must be a UUID"))
        #expect(SendFailure(APIError.server(status: 418, message: nil)) == .unknown)
        #expect(SendFailure(CancellationError()) == .unknown)
    }

    @Test func onlyAFailureARetryCanFixOffersRetry() {
        for failure in [SendFailure.offline, .unreachable, .sessionExpired, .serverError, .unknown] {
            #expect(failure.retryable)
        }
        for failure in [SendFailure.archived, .notFound, .chatOff, .rejected("no")] {
            #expect(!failure.retryable)
        }
        #expect(SendFailure.unknown.line == "Not sent · Tap to retry")
        #expect(SendFailure.offline.line == "Not sent · No network · Tap to retry")
        #expect(SendFailure.archived.line == "Not sent · Chat is archived")
    }
}

@Suite struct TurnErrorTests {
    private func parse(_ part: [String: Any]) -> TurnError? {
        if case .error(let error)? = MessagePart.parse(json([part])).first { return error }
        return nil
    }

    @Test func keepsTheFieldsOfAStoredModelError() {
        let error = parse(["type": "error", "error": "All connected model providers have reached their usage limits", "code": "no_model_provider_available", "reason": "quota_exhausted"])
        #expect(error?.kind == .allAtLimit)
        #expect(error?.title == "All AI tools are at their limits")
        #expect(error?.hint != nil)
        #expect(error?.offersUsage == true)
    }

    @Test func namesTheProviderThatIsAtItsLimit() {
        let error = parse(["type": "error", "error": "x", "code": "model_provider_unavailable", "provider": "openai", "reason": "quota_exhausted"])
        #expect(error?.kind == .limit)
        #expect(error?.title == "Codex usage limit reached")
        #expect(parse(["type": "error", "error": "x", "provider": "anthropic", "reason": "not_logged_in"])?.title == "Claude is not signed in")
        #expect(parse(["type": "error", "error": "x", "code": "credits_used_up"])?.kind == .creditsUsedUp)
        #expect(parse(["type": "error", "error": "x", "code": "model_unavailable"])?.kind == .noProvider)
        #expect(TurnError(text: "Quota exceeded for the maps API", fromTrace: true).kind == .other)
        #expect(parse(["type": "error", "error": "x", "code": "model_unavailable", "reason": "model_access_denied"])?.kind == .modelDenied)
    }

    @Test func anErrorWithNoKnownCodeShowsItsOwnWords() {
        let error = parse(["type": "error", "error": "Process exited"])
        #expect(error?.kind == .other)
        #expect(error?.title == "Process exited")
        #expect(error?.offersUsage == false)
        #expect(parse(["type": "error"])?.title == "This turn did not finish")
    }

    @Test func aFailedTurnsTraceIsReadForALimit() {
        #expect(TurnError(text: "You've hit your limit · resets 3pm", fromTrace: true).kind == .limit)
        #expect(TurnError(text: "Credit balance is too low", fromTrace: true).kind == .limit)
        #expect(TurnError(text: "Tool crashed", fromTrace: true).kind == .other)
        // Only a trace is read for words; a stored error says its kind in fields.
        #expect(TurnError(text: "You've hit your limit").kind == .other)
        #expect(TurnError(text: "You've hit your limit", fromTrace: true).detail == "You've hit your limit")
    }

    @Test func aModelSwitchSaysWhy() {
        func text(_ part: [String: Any]) -> String? {
            if case .notice(let text)? = MessagePart.parse(json([part])).first { return text }
            return nil
        }
        #expect(text(["type": "quota_switch", "from": "openai", "to": "anthropic", "reason": "quota", "model": "claude-sonnet-5-5"]) == "Codex ran out, switched to Claude")
        #expect(text(["type": "quota_switch", "from": "anthropic", "to": "openai", "reason": "login", "model": "gpt-6"]) == "Claude sign-in failed, switched to Codex")
        #expect(text(["type": "quota_switch", "from": "anthropic", "to": "anthropic", "reason": "model_limit", "fromModel": "claude-opus-5-5[1m]", "model": "claude-sonnet-5-5"]) == "claude-opus-5-5 limit reached, switched to claude-sonnet-5-5")
        #expect(text(["type": "quota_switch", "model": "gpt-6"]) == "Switched to gpt-6")
    }
}

@Suite struct FailedTurnRowTests {
    private func rows(_ messages: [ChatMessage], tools: Bool = false) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init(showTools: tools))
    }

    private func errors(_ rows: [TranscriptRow]) -> [TurnError] {
        rows.compactMap { if case .error(_, let error) = $0 { error } else { nil } }
    }

    @Test func aTurnThatFailedMidRunShowsWhy() {
        let trace = TraceSummary(totalSteps: 0, turnStatus: "error", terminalError: "You've hit your limit")
        let list = rows([
            message("u", role: "user", turn: "t", [["type": "text", "content": "hi"]], at: 0),
            message("tr", role: "trace", turn: "t", at: 1, trace: trace),
        ])
        #expect(errors(list).map(\.kind) == [.limit])
    }

    @Test func aFinishedOrStoppedTurnShowsNothing() {
        let list = rows([
            message("a", role: "trace", turn: "t1", at: 1, trace: TraceSummary(totalSteps: 0, turnStatus: "completed")),
            message("b", role: "trace", turn: "t2", at: 2, trace: TraceSummary(totalSteps: 0, turnStatus: "interrupted")),
        ])
        #expect(errors(list).isEmpty)
    }

    @Test func aTurnWhoseReplyIsAnErrorShowsItOnce() {
        let list = rows([
            message("u", role: "user", turn: "t", [["type": "text", "content": "hi"]], at: 0),
            message("e", turn: "t", [["type": "error", "error": "x", "code": "no_model_provider_available", "reason": "quota_exhausted"]], at: 1),
            message("tr", role: "trace", turn: "t", at: 1, trace: TraceSummary(totalSteps: 0, turnStatus: "error", terminalError: "x")),
        ])
        #expect(errors(list).count == 1)
    }

    @Test func aFailureTheChatRecoveredFromShowsNoLine() {
        let trace = TraceSummary(totalSteps: 0, turnStatus: "error", terminalError: "You've hit your limit")
        let failed = message("tr", role: "trace", turn: "t1", at: 1, trace: trace)
        let switched = message("sw", [["type": "quota_switch", "from": "openai", "to": "anthropic", "reason": "quota", "model": "claude-sonnet-5-5"]], at: 2)
        let user = message("u", role: "user", turn: "t1", [["type": "text", "content": "hi"]], at: 0)
        // Failed, switched, nothing said yet: the line stays.
        #expect(errors(rows([user, failed, switched])).count == 1)
        // The recovery turn replied: no line.
        let reply = message("r", turn: "t2", [["type": "text", "content": "Done"]], at: 3)
        #expect(errors(rows([user, failed, switched, reply])).isEmpty)
        // A turn that said something and then failed shows none either.
        let partial = message("p", turn: "t1", [["type": "text", "content": "Working…"]], at: 0.5)
        #expect(errors(rows([user, partial, failed])).isEmpty)
    }

    @Test func aTaskChatKeepsItsToolsRowAndAddsTheLine() {
        let list = rows([
            message("tr", role: "trace", turn: "t", at: 1, trace: TraceSummary(totalSteps: 3, turnStatus: "error", terminalError: "Tool crashed")),
        ], tools: true)
        #expect(list.contains { if case .tools = $0 { true } else { false } })
        #expect(errors(list).first?.title == "Tool crashed")
    }

    @Test func aStoredMessageTheInstanceCouldNotDeliverSaysSo() {
        let list = rows([
            message("a", role: "user", [["type": "text", "content": "one"]], at: 0, inputState: "failed"),
            message("b", role: "user", [["type": "text", "content": "two"]], at: 1, inputState: "unknown"),
            message("c", role: "user", [["type": "text", "content": "three"]], at: 2, inputState: "consumed"),
        ])
        let states = list.compactMap { row -> PendingSend.State?? in if case .userText(_, _, _, let state) = row { .some(state) } else { nil } }
        #expect(states == [.some(.notDelivered), .some(.unconfirmed), .none])
        // They are stored messages still: the menu keeps their ids.
        #expect(list.compactMap(\.messageId).count == 3)
    }
}

@MainActor
@Suite struct StatusMarkTests {
    @Test func aGuardianMessageShowsTheMarkTheServerSends() async {
        let backend = FakeBackend()
        backend.stored = [message("u", role: "user", [["type": "text", "content": "hi"]], at: 0, reaction: "working")]
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        await store.reload()
        let row = store.rows.first { $0.messageId == "u" }!
        #expect(store.statusMark(ofRow: row) == .working)

        store.start()
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .statusReaction(sessionId: conciergeChatID, messageId: "u", reaction: "failed"))
        #expect(store.statusMark(ofRow: row) == .failed)
        backend.bus.emit(LiveTopic.chat(conciergeChatID), .statusReaction(sessionId: conciergeChatID, messageId: "u", reaction: nil))
        #expect(store.statusMark(ofRow: row) == nil)
        store.stop()
    }

    @Test func aTaskChatHasNoMarks() async {
        let backend = FakeBackend()
        backend.stored = [message("u", role: "user", [["type": "text", "content": "hi"]], at: 0, reaction: "failed")]
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.statusMark(ofRow: store.rows.first { $0.messageId == "u" }!) == nil)
    }

    @Test func decodesTheMarkAndTheInputStateAndTheEvent() {
        let data = #"{"id":"m","sessionId":"s","role":"user","content":"[]","createdAt":"2026-11-12T10:00:00Z","inputState":"failed","statusReaction":"working"}"#.data(using: .utf8)!
        let decoded = try! JSONDecoder().decode(ChatMessage.self, from: data)
        #expect(decoded.inputState == "failed" && decoded.statusReaction == "working")
        let event = LiveEventsSocket.decode(name: "message_status_reaction", data: .object(["sessionId": .string("s"), "messageId": .string("m"), "statusReaction": .null]))
        if case .statusReaction(let session, let id, let reaction)? = event {
            #expect(session == "s" && id == "m" && reaction == nil)
        } else {
            Issue.record("event not read")
        }
    }
}

@MainActor
@Suite struct SendFailureStoreTests {
    private func settle(_ store: TranscriptStore) async {
        for _ in 0..<50 where store.pending.first?.state == .sending { try? await Task.sleep(for: .milliseconds(20)) }
        try? await Task.sleep(for: .milliseconds(50))
    }

    @Test func aFailedSendKeepsItsReason() async {
        let backend = FakeBackend()
        backend.sendError = .server(status: 409, message: "This chat is archived and read-only")
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        store.send("hello")
        await settle(store)
        #expect(store.pending.first?.state == .failed(.archived))
    }

    @Test func aFailedSendOfflineLeavesNoTypingDots() async {
        let backend = FakeBackend()
        backend.sendError = .offline
        backend.activeTurnsError = .offline
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.send("hello")
        #expect(store.running)
        await settle(store)
        #expect(store.pending.first?.state == .failed(.offline))
        #expect(!store.running && !store.visibleTurn)
        #expect(!store.rows.contains { $0 == .typing })
    }

    @Test func aSendTheServerTookWithNoTurnClearsTheDots() async {
        let backend = FakeBackend()
        backend.sendSucceeds = true
        backend.sendTurnId = nil
        backend.turns = []
        let store = TranscriptStore(sessionId: conciergeChatID, kind: .concierge, backend: backend)
        store.send("hello")
        #expect(store.running)
        for _ in 0..<100 where store.running { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(store.pending.first?.state == .sent)
        #expect(!store.running && !store.visibleTurn)
        #expect(!store.rows.contains { $0 == .typing })
    }

    @Test func aLoadFailureIsToldUnlessOfflineOrSignedOut() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 500, message: nil)
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.loadFailed)
        backend.messagesError = .offline
        await store.reload()
        #expect(!store.loadFailed)
    }

    @Test func aFetchThatWorksClearsTheLoadError() async {
        let backend = FakeBackend()
        backend.messagesError = .server(status: 500, message: nil)
        let store = TranscriptStore(sessionId: "task", kind: .task, backend: backend)
        await store.reload()
        #expect(store.loadFailed)
        backend.messagesError = nil
        #expect(await store.refreshLatest())
        #expect(!store.loadFailed)
    }
}
