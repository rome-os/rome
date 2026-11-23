import Foundation
import Testing
@testable import Rome

/// Provider failure cards and the outage notice, drawn from the server's
/// parts (docs/domains/agents.md#provider-failure).
@MainActor
@Suite struct ProviderFailureTests {
    private static let created = RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000))

    private func failure(_ fields: [String: Any]) -> ProviderFailurePart {
        var part: [String: Any] = ["type": "provider_failure", "chatId": "c", "followsDefault": true, "alternatives": [String]()]
        part.merge(fields) { _, new in new }
        guard case .providerFailure(let parsed)? = parts([part]).first else {
            Issue.record("Not a failure card")
            return ProviderFailurePart(provider: .openai, reason: "quota", chatId: "c")
        }
        return parsed
    }

    private func parts(_ items: [[String: Any]]) -> [MessagePart] {
        MessagePart.parse(content(items))
    }

    private func content(_ items: [[String: Any]]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: items), encoding: .utf8)!
    }

    private func rows(_ messages: [ChatMessage]) -> [TranscriptRow] {
        TranscriptBuilder.rows(messages: messages, pending: [], answers: [:], options: .init())
    }

    // MARK: Decoding and buttons

    @Test func aWaitCardOffersTheOtherAccountUntilItsResetPasses() {
        let now = Date.now
        let part = failure(["provider": "openai", "reason": "quota", "card": "wait", "until": RomeDate.string(now.addingTimeInterval(3600)), "alternatives": ["anthropic", "rome_credits"]])
        #expect(part.kind == .wait)
        #expect(part.alternatives == [.anthropic, .romeCredits])
        // Credits are no account to switch to on a wait card; before its reset
        // Retry comes last, as on the web.
        #expect(ProviderFailureAction.of(part, now: now) == [.switchTo(.anthropic), .retry])
        // Once the reset passed, Continue comes first.
        #expect(ProviderFailureAction.of(part, now: now.addingTimeInterval(7200)) == [.continueTurn, .switchTo(.anthropic)])
        #expect(ProviderFailureAction.switchTo(.anthropic).title == "Switch to Claude")
        #expect(ProviderFailureAction.switchTo(.anthropic).switchBody == .object(["kind": .string("provider"), "provider": .string("anthropic"), "makeDefault": .bool(false)]))
    }

    @Test func aTemporaryWaitRetries() {
        let part = failure(["provider": "anthropic", "reason": "temporary"])
        // A card from before `card` reads its kind from the reason.
        #expect(part.card == nil)
        #expect(part.kind == .wait)
        #expect(ProviderFailureAction.of(part) == [.retry])
        #expect(ProviderFailureAction.retry.switchBody == nil)
        #expect(ProviderFailureCopy.reason(part) == "Claude is unavailable for now")
        #expect(ProviderFailureCopy.status(part) == "Paused")
    }

    @Test func anAccountCardLogsInOrSwitches() {
        let part = failure(["provider": "openai", "reason": "login", "card": "account", "alternatives": ["anthropic"], "detail": "401 Unauthorized"])
        #expect(part.kind == .account)
        #expect(part.detail == "401 Unauthorized")
        // Retry is on every card: last where something else does the job.
        #expect(ProviderFailureAction.of(part) == [.logIn, .switchTo(.anthropic), .retry])
        #expect(ProviderFailureCopy.status(part) == "Needs you")
        #expect(ProviderFailureCopy.reason(part) == "ChatGPT needs you to log in again")
        // No account left and a balance: Rome credits.
        let credits = failure(["provider": "openai", "reason": "removed", "credits": true])
        #expect(credits.kind == .account)
        #expect(ProviderFailureAction.of(credits) == [.logIn, .useCredits, .retry])
        #expect(ProviderFailureAction.useCredits.switchBody == .object(["kind": .string("provider"), "provider": .string("rome_credits"), "makeDefault": .bool(true)]))
        #expect(ProviderFailureAction.useCredits.confirms)
    }

    @Test func aModelCardSwitchesWithinItsProvider() {
        let part = failure(["provider": "openai", "reason": "model_unavailable", "model": "gpt-6-sol", "replacement": ["selection": "gpt-6-luna", "model": "gpt-6-luna"], "alternatives": ["anthropic"]])
        #expect(part.kind == .model)
        let actions = ProviderFailureAction.of(part)
        #expect(actions == [.switchModel(.init(selection: "gpt-6-luna", model: "gpt-6-luna")), .retry])
        #expect(actions.first?.title == "Switch to GPT-6 Luna")
        #expect(actions.first?.confirms == false)
        #expect(actions.first?.switchBody == .object(["kind": .string("model"), "selection": .string("gpt-6-luna")]))
        #expect(ProviderFailureCopy.status(part) == "Model unavailable")
        #expect(ProviderFailureCopy.reason(part) == "GPT-6 Sol is unavailable")
    }

    @Test func aWaitThatContinuesByItselfSaysSo() {
        let now = Date.now
        let soon = Calendar.current.date(byAdding: .minute, value: 1, to: now)!
        guard Calendar.current.isDate(soon, inSameDayAs: now) else { return }
        let time = soon.formatted(date: .omitted, time: .shortened)
        let promise = failure(["provider": "openai", "reason": "quota", "until": RomeDate.string(soon), "continues": true])
        #expect(ProviderFailureCopy.status(promise, now: now) == "Paused · continues after \(time)")
        let paused = failure(["provider": "openai", "reason": "quota", "until": RomeDate.string(soon)])
        #expect(ProviderFailureCopy.status(paused, now: now) == "Paused until \(time)")
        #expect(ProviderFailureCopy.reason(paused, now: now) == "ChatGPT quota used up")
    }

    @Test func aSettledCardReadsAsOneLine() {
        typealias Resolution = ProviderFailurePart.Resolution
        #expect(ProviderFailureCopy.resolved(Resolution(by: "switched", provider: .anthropic, continued: true)) == "Switched to Claude, continued")
        // Written before `continued` existed: it ran.
        #expect(ProviderFailureCopy.resolved(Resolution(by: "switched", provider: .anthropic)) == "Switched to Claude, continued")
        #expect(ProviderFailureCopy.resolved(Resolution(by: "switched", provider: .anthropic, continued: false)) == "Switched to Claude")
        #expect(ProviderFailureCopy.resolved(Resolution(by: "switched", model: "gpt-6-luna")) == "Switched to GPT-6 Luna, continued")
        #expect(ProviderFailureCopy.resolved(Resolution(by: "recovered")) == "Recovered, continued")
    }

    @Test func aPartMissingItsProviderIsJustACard() {
        #expect(parts([["type": "provider_failure", "reason": "quota"]]) == [.webOnly(.unknown)])
        #expect(parts([["type": "provider_outage", "provider": "openai"]]) == [.webOnly(.unknown)])
    }

    // MARK: Rows

    @Test func cardsBecomeRowsAndSettledOnesALine() {
        let open: [String: Any] = ["type": "provider_failure", "provider": "openai", "reason": "login", "chatId": "s", "alternatives": [String]()]
        var settled = open
        settled["resolved"] = ["at": Self.created, "by": "switched", "provider": "anthropic", "continued": true]
        var retrying = open
        retrying["retrying"] = true
        var moved = open
        moved["resolved"] = ["at": Self.created, "by": "moved"]
        let messages = [
            ChatMessage(id: "a", sessionId: "s", role: "assistant", content: content([open]), createdAt: Self.created),
            ChatMessage(id: "b", sessionId: "s", role: "assistant", content: content([settled]), createdAt: Self.created),
            ChatMessage(id: "c", sessionId: "s", role: "assistant", content: content([retrying]), createdAt: Self.created),
            ChatMessage(id: "d", sessionId: "s", role: "assistant", content: content([moved]), createdAt: Self.created),
        ]
        let drawn = rows(messages).filter { if case .separator = $0 { false } else { true } }
        #expect(drawn.count == 2)
        guard case .providerFailure(let id, let part, let messageId)? = drawn.first else {
            Issue.record("No card row")
            return
        }
        #expect(id == "a:0")
        #expect(messageId == "a")
        #expect(part.reason == "login")
        #expect(drawn.last == .notice(id: "b:0", text: "Switched to Claude, continued"))
    }

    @Test func aCardTakesThePlaceOfItsErrorAndItsFailedSend() {
        let card: [String: Any] = ["type": "provider_failure", "provider": "openai", "reason": "quota", "chatId": "s", "alternatives": [String]()]
        let error: [String: Any] = ["type": "error", "error": "Usage limit reached", "code": "usage_limit"]
        let messages = [
            ChatMessage(id: "u", sessionId: "s", turnId: "t1", role: "user", content: content([["type": "text", "text": "Hi"]]), createdAt: Self.created, inputState: "failed"),
            ChatMessage(id: "a", sessionId: "s", turnId: "t1", role: "assistant", content: content([error, card]), createdAt: Self.created),
            ChatMessage(id: "tr", sessionId: "s", turnId: "t1", role: "trace", content: "[]", createdAt: Self.created, traceSummary: TraceSummary(totalSteps: 0, turnStatus: "error", terminalError: "Usage limit reached")),
        ]
        let drawn = rows(messages)
        #expect(!drawn.contains { if case .error = $0 { true } else { false } })
        #expect(drawn.contains { if case .providerFailure = $0 { true } else { false } })
        #expect(drawn.contains { if case .userText(_, _, _, nil) = $0 { true } else { false } })
    }

    @Test func anOutageNoticeListsItsTasksUntilSettled() {
        let notice: [String: Any] = ["type": "provider_outage", "outageId": "o", "provider": "openai", "reason": "quota", "chatIds": ["t-1", "t-2"]]
        var settled = notice
        settled["resolvedAt"] = Self.created
        let drawn = rows([
            ChatMessage(id: "n", sessionId: "s", role: "assistant", content: content([notice]), createdAt: Self.created),
            ChatMessage(id: "m", sessionId: "s", role: "assistant", content: content([settled]), createdAt: Self.created),
        ]).filter { if case .separator = $0 { false } else { true } }
        guard case .providerOutage(_, let part)? = drawn.first else {
            Issue.record("No notice row")
            return
        }
        #expect(part.chatIds == ["t-1", "t-2"])
        #expect(ProviderFailureCopy.outage(part) == "ChatGPT hit its usage limit. You can continue once it resets.")
        #expect(ProviderFailureCopy.waiting(2) == "2 tasks waiting")
        #expect(ProviderFailureCopy.waiting(1) == "1 task waiting")
        #expect(ProviderOutageNotice.links(["t-1"]) == "[Task](#rome-task=t-1)")
        // Every task ran again: one line, which says nothing about each task's turn.
        #expect(drawn.last == .notice(id: "m:0", text: "Recovered"))
    }

    // MARK: Pressing a button

    @Test func aPressWaitsForTheServerToSettleTheCard() async throws {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        let part = ProviderFailurePart(provider: .anthropic, reason: "temporary", chatId: "s")
        store.press(.retry, part: part, messageId: "m1")
        try await until { backend.failureCalls.count == 1 }
        #expect(backend.failureCalls.first?.messageId == "m1")
        #expect(backend.failureCalls.first?.change == nil)
        // Nothing settles it here: the card stays pending, its buttons off.
        #expect(store.failurePending.contains("m1"))
        // A second press is not sent.
        await store.send(.retry, messageId: "m1")
        #expect(backend.failureCalls.count == 1)
    }

    @Test func aPendingCardGetsItsButtonsBackIfNothingSettlesIt() async throws {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        let limit = TranscriptStore.failurePendingLimit
        TranscriptStore.failurePendingLimit = .milliseconds(30)
        defer { TranscriptStore.failurePendingLimit = limit }
        await store.send(.switchModel(.init(selection: "gpt-6-luna", model: "gpt-6-luna")), messageId: "m1")
        #expect(store.failurePending.contains("m1"))
        try await until { !store.failurePending.contains("m1") }
    }

    @Test func aFailedPressSaysSoAndTakesAnotherTry() async {
        let backend = FakeBackend()
        backend.failureError = .network
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.send(.switchTo(.anthropic), messageId: "m1")
        #expect(!store.failurePending.contains("m1"))
        #expect(store.failureErrors["m1"] == .switchTo(.anthropic))
        backend.failureError = nil
        await store.send(.switchTo(.anthropic), messageId: "m1")
        #expect(store.failureErrors["m1"] == nil)
        #expect(backend.failureCalls.count == 1)
    }

    @Test func aSwitchAsksFirstAndLogInOpensTheAccountsLogin() async throws {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        let part = ProviderFailurePart(provider: .openai, reason: "login", alternatives: [.anthropic], chatId: "s")
        store.press(.switchTo(.anthropic), part: part, messageId: "m1")
        #expect(store.failurePrompt == .confirm(messageId: "m1", action: .switchTo(.anthropic)))
        #expect(backend.failureCalls.isEmpty)
        store.press(.logIn, part: part, messageId: "m1")
        #expect(store.failurePrompt == .logIn(.chatgpt))
    }

    @Test func retryOnAnAccountCardRunsTheTurnWhereItRan() async throws {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        let part = ProviderFailurePart(provider: .openai, reason: "login", alternatives: [.anthropic], chatId: "s", card: .account)
        #expect(ProviderFailureAction.of(part).last == .retry)
        store.press(.retry, part: part, messageId: "m1")
        try await until { backend.failureCalls.count == 1 }
        // The web's Retry: the continue route, with no switch.
        #expect(backend.failureCalls.first?.change == nil)
    }

    @Test func aSwitchCanAlsoMakeTheAccountTheDefault() {
        #expect(ProviderFailureAction.switchAndMakeDefault(.anthropic).switchBody == .object(["kind": .string("provider"), "provider": .string("anthropic"), "makeDefault": .bool(true), "moveExisting": .bool(true)]))
        #expect(ProviderFailureAction.switchAndMakeDefault(.anthropic).title == "Switch all chats and make default")
        #expect(ProviderFailurePrompts.body(.switchTo(.anthropic)) == "This chat continues on Claude, and the stopped turn picks up again.\n\nYour other chats move to Claude too. Chats where you picked a model keep it.")
    }

    @Test func aStaleOptionRedrawsWithNoError() async {
        let backend = FakeBackend()
        backend.switchRefreshes = true
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.send(.switchTo(.anthropic), messageId: "m1")
        // The server wrote a fresh card: nothing waits, nothing failed.
        #expect(!store.failurePending.contains("m1"))
        #expect(store.failureErrors["m1"] == nil)
        #expect(backend.sessionReads == 0)
    }

    @Test func aSwitchReadsWhetherTheChatIsPinnedNow() async {
        let backend = FakeBackend()
        backend.chatSessionRead = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "anthropic"))
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.send(.switchTo(.anthropic), messageId: "m1")
        #expect(PinnedHint.text(store.chatSession) == "On Claude")
    }

    @Test func aOneTurnSwapSaysItWasForThisReply() {
        let swap = parts([["type": "quota_switch", "from": "anthropic", "to": "anthropic", "reason": "model_limit", "fromModel": "claude-opus-5-5", "model": "claude-sonnet-5-5", "oneTurn": true]])
        #expect(swap == [.notice("Used Sonnet 5.5 for this reply")])
        // Older notes moved for good, and say so.
        let older = parts([["type": "quota_switch", "from": "anthropic", "to": "anthropic", "reason": "model_limit", "fromModel": "claude-opus-5-5", "model": "claude-sonnet-5-5"]])
        #expect(older == [.notice("Opus 5.5 limit reached, switched to Sonnet 5.5")])
    }

    // MARK: Pinned chats

    @Test func aPinnedChatSaysWhereItRunsAndWhoPinnedIt() {
        #expect(PinnedHint.text(ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "openai", model: "gpt-6-luna"))) == "On ChatGPT")
        #expect(PinnedHint.text(ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "owner", providerId: "anthropic", selection: "claude-haiku", model: "claude-haiku-5-5"))) == "You picked Haiku 5.5")
        // An owner pick the server names no model for reads its provider.
        #expect(PinnedHint.text(ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "owner", providerId: "anthropic"))) == "You picked Claude")
        // A chat that follows the default, or a server that does not say: none.
        #expect(PinnedHint.text(ChatSession(id: "s", name: "", followsDefault: true)) == nil)
        #expect(PinnedHint.text(ChatSession(id: "s", name: "")) == nil)
        #expect(PinnedHint.text(nil) == nil)
    }

    @Test func thePinnedFieldsDecodeFromTheWire() throws {
        let json = #"{"id":"s","name":"n","followsDefault":false,"pinnedModel":{"by":"owner","providerId":"anthropic","selection":"claude-haiku","model":null}}"#
        let session = try JSONDecoder().decode(ChatSession.self, from: Data(json.utf8))
        #expect(session.followsDefault == false)
        #expect(session.pinnedModel == .init(by: "owner", providerId: "anthropic", selection: "claude-haiku", model: nil))
    }

    @Test func aFailedBackToDefaultKeepsTheHintAndSaysSo() async {
        let backend = FakeBackend()
        backend.chatSessionRead = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "openai"))
        backend.followDefaultFails = true
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.readChatSession()
        await store.followDefault()
        #expect(PinnedHint.text(store.chatSession) == "On ChatGPT")
        #expect(store.notice == "Could not go back to the default. Try again.")
    }

    @Test func aResyncReadsThePinAgain() async throws {
        // A topic stays mounted while Settings changes the default with
        // "Only new chats": the server pins it, and the next resync shows it.
        let backend = FakeBackend()
        backend.chatSessionRead = ChatSession(id: "s", name: "", followsDefault: true)
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.readChatSession()
        #expect(PinnedHint.text(store.chatSession) == nil)
        backend.chatSessionRead = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "anthropic"))
        store.resync()
        try await until { PinnedHint.text(store.chatSession) == "On Claude" }
    }

    @Test func backToDefaultSaysWhereTheChatGoes() {
        let kept = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "anthropic"))
        #expect(PinnedHint.confirmBody(kept, default: .openai) == "This chat moves from Claude to ChatGPT, your default, from its next reply.")
        let owner = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "owner", providerId: "anthropic", selection: "claude-haiku", model: "claude-haiku-5-5"))
        #expect(PinnedHint.confirmBody(owner, default: .openai) == "This chat stops using Haiku 5.5 and follows your default, ChatGPT, from its next reply.")
        #expect(PinnedHint.confirmBody(kept, default: nil) == "This chat follows your default from its next reply.")
    }

    @Test func theHintIsTheTranscriptsLastRowForTheGuardianOnly() async {
        let backend = FakeBackend()
        backend.chatSessionRead = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "openai"))
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        #expect(PinnedHintLine.footer(store, visitor: false) == nil)
        await store.readChatSession()
        #expect(PinnedHintLine.footer(store, visitor: false) != nil)
        #expect(PinnedHintLine.footer(store, visitor: true) == nil)
    }

    @Test func backToDefaultHidesTheHint() async {
        let backend = FakeBackend()
        backend.chatSessionRead = ChatSession(id: "s", name: "", followsDefault: false, pinnedModel: .init(by: "kept", providerId: "openai"))
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.readChatSession()
        #expect(PinnedHint.text(store.chatSession) == "On ChatGPT")
        await store.followDefault()
        #expect(backend.followDefaultCalls == ["s"])
        #expect(PinnedHint.text(store.chatSession) == nil)
    }

    /// Waits up to ten seconds for `condition`: a loaded CI runner is slow.
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<1000 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("Timed out")
    }
}
