import Foundation
import Testing
@testable import Rome

/// Settings' AI model row, the AI model page's account lines, and the two
/// logins (docs/domains/agents.md#default-provider).
@MainActor
@Suite struct AIModelTests {
    private typealias Provider = AIToolsStatus.Provider

    private static let usage = AIToolsStatus.Usage(fiveHour: .init(usedPercent: 12, resetsAt: nil), sevenDay: .init(usedPercent: 8, resetsAt: nil))

    private func status(claude: Provider? = Provider(loggedIn: false), codex: Provider? = Provider(loggedIn: false), default provider: DefaultModelProvider?) -> AIToolsStatus {
        AIToolsStatus(claude: claude, codex: codex, defaultProvider: .init(provider: provider))
    }

    @Test func aDefaultThatRunsShowsItsTightestWindow() {
        let read = status(codex: Provider(loggedIn: true, usage: Self.usage, quotaExhausted: false), default: .openai)
        let summary = AIModelSummary.of(read, showsUsage: true, credits: nil)
        #expect(summary == .ready(.openai, usage: "12% of 5h used"))
        #expect(summary.text == "ChatGPT · 12% of 5h used")
        #expect(summary.tone == .plain)
        // With usage turned off on the web, the name alone.
        #expect(AIModelSummary.of(read, showsUsage: false, credits: nil).text == "ChatGPT")
    }

    @Test func aWeeklyWindowCanBeTheTightest() {
        let usage = AIToolsStatus.Usage(fiveHour: .init(usedPercent: 3), sevenDay: .init(usedPercent: 71.6))
        #expect(AIUsageText.used(usage) == "72% of 7d used")
        #expect(AIUsageText.used(nil) == nil)
    }

    @Test func aDefaultAtItsQuotaWaitsInWarning() {
        let now = Date.now
        let until = now.addingTimeInterval(3600)
        let read = status(codex: Provider(loggedIn: true, quotaExhausted: true, quotaExhaustedUntil: RomeDate.string(until)), default: .openai)
        let summary = AIModelSummary.of(read, showsUsage: true, credits: nil)
        #expect(summary == .paused(.openai, until: RomeDate.string(until)))
        #expect(summary.tone == .warning)
        #expect(summary.text.hasPrefix("ChatGPT · Quota used up until "))
        // No end known, or one passed: no time.
        #expect(AIUsageText.quota(until: nil) == "Quota used up")
        #expect(AIUsageText.quota(until: RomeDate.string(now.addingTimeInterval(-60))) == "Quota used up")
    }

    @Test func anExpiredDefaultNeedsTheGuardian() {
        let read = status(codex: Provider(loggedIn: false, needsReauth: true), default: .openai)
        let summary = AIModelSummary.of(read, showsUsage: true, credits: nil)
        #expect(summary == .needsLogin(.openai, expired: true))
        #expect(summary.text == "ChatGPT · Log in again")
        #expect(summary.tone == .danger)
        // The only account logged out and no credits took over: nothing runs.
        let gone = AIModelSummary.of(status(codex: Provider(loggedIn: false), default: .openai), showsUsage: true, credits: nil)
        #expect(gone == .notSetUp)
        #expect(gone.offersConnect)
        // The default logged out while the other runs: the default says so.
        let other = AIModelSummary.of(status(claude: Provider(loggedIn: true), codex: Provider(loggedIn: false), default: .openai), showsUsage: true, credits: nil)
        #expect(other.text == "ChatGPT · Not logged in")
    }

    @Test func noDefaultMeansChatCannotReply() {
        let summary = AIModelSummary.of(status(default: nil), showsUsage: true, credits: nil)
        #expect(summary == .notSetUp)
        #expect(summary.text == "Not set up")
        #expect(summary.tone == .danger)
        #expect(summary.offersConnect)
        // Credits a server could use, but not chosen: still not set up.
        var usable = status(default: nil)
        usable.defaultProvider?.romeCreditsUsable = true
        #expect(AIModelSummary.of(usable, showsUsage: true, credits: 2).offersConnect)
    }

    @Test func romeCreditsAsTheDefaultShowWhatIsLeft() {
        let summary = AIModelSummary.of(status(default: .romeCredits), showsUsage: true, credits: 2)
        #expect(summary == .credits(dollars: 2))
        #expect(summary.text == "Rome credits · $2.00 left")
        #expect(AIModelSummary.of(status(default: .romeCredits), showsUsage: true, credits: nil).text == "Rome credits")
    }

    @Test func noDefaultSetYetReadsTheLoggedInAccount() {
        let read = AIToolsStatus(claude: Provider(loggedIn: true), codex: Provider(loggedIn: false))
        #expect(AIModelSummary.of(read, showsUsage: false, credits: nil) == .ready(.anthropic, usage: nil))
        #expect(AIModelSummary.of(nil, showsUsage: true, credits: nil) == .loading)
    }

    @Test func theDefaultDecodesFromTheWire() throws {
        let json = #"{"claude":{"loggedIn":true,"quotaExhausted":false},"codex":{"loggedIn":false,"needsReauth":true,"quotaExhausted":false},"codexDeviceLogin":{"running":true,"userCode":"AB-12","verificationUrl":"https://x","lastError":null},"defaultProvider":{"provider":"rome_credits","signedIn":{"anthropic":true,"openai":false},"followingChats":3,"romeCreditsUsable":true}}"#
        let read = try JSONDecoder().decode(AIToolsStatus.self, from: Data(json.utf8))
        #expect(read.defaultProvider?.provider == .romeCredits)
        #expect(read.codex?.needsReauth == true)
        #expect(read.codexDeviceLogin?.userCode == "AB-12")
        // A provider this build does not know still decodes.
        let newer = try JSONDecoder().decode(AIToolsStatus.DefaultState.self, from: Data(#"{"provider":"gemini"}"#.utf8))
        #expect(newer.provider == .unknown("gemini"))
    }

    @Test func accountLinesOfferWhatFitsTheirState() {
        #expect(AIAccountLine.of(Provider(loggedIn: true, usage: Self.usage), showsUsage: true) == .init(text: "Logged in · 12% of 5h used", tone: .plain, action: .logOut))
        #expect(AIAccountLine.of(Provider(loggedIn: true, usage: Self.usage), showsUsage: false).text == "Logged in")
        #expect(AIAccountLine.of(Provider(loggedIn: false), showsUsage: true) == .init(text: "Not logged in", tone: .plain, action: .logIn))
        // An expired login still counts as signed in: it can be logged in again or logged out.
        #expect(AIAccountLine.of(Provider(loggedIn: false, needsReauth: true), showsUsage: true) == .init(text: "Login expired", tone: .danger, action: .logInOrOut))
        #expect(AIAccountLine.of(Provider(loggedIn: true, quotaExhausted: true), showsUsage: true) == .init(text: "Logged in · Quota used up", tone: .warning, action: .logOut))
        // An API key is managed on the web.
        #expect(AIAccountLine.of(Provider(loggedIn: true, authMethod: "environment"), showsUsage: true).action == .none)
    }

    // MARK: ChatGPT device login

    @Test func aDeviceLoginShowsItsCodeThenCompletes() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(codex: Provider(loggedIn: false))
        let flow = ChatGPTLoginFlow(backend: backend, pollInterval: .milliseconds(10))
        var connected: AIToolsStatus?
        flow.onConnected = { connected = $0 }
        flow.start()
        try await until { flow.phase == .code("ABCD-1234", URL(string: "https://auth.example/device")) }
        backend.aiStatus = AIToolsStatus(codex: Provider(loggedIn: true))
        try await until { flow.phase == .connected }
        #expect(connected?.codex?.loggedIn == true)
        // Done: a dismissal cancels nothing.
        flow.cancel()
        #expect(backend.deviceLoginCancels == 0)
    }

    @Test func aDeviceLoginTheServerFailedSaysWhy() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(codex: Provider(loggedIn: false), codexDeviceLogin: .init(lastError: "Code expired"))
        let flow = ChatGPTLoginFlow(backend: backend, pollInterval: .milliseconds(10))
        flow.start()
        try await until { flow.phase == .failed("Code expired") }
    }

    @Test func closingAWaitingDeviceLoginCancelsIt() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(codex: Provider(loggedIn: false))
        let flow = ChatGPTLoginFlow(backend: backend, pollInterval: .milliseconds(10))
        flow.start()
        try await until { if case .code = flow.phase { return true } else { return false } }
        flow.cancel()
        try await until { backend.deviceLoginCancels == 1 }
        let reads = backend.aiReads
        try await Task.sleep(for: .milliseconds(60))
        #expect(backend.aiReads == reads)
    }

    // MARK: Claude login

    @Test func aClaudeLoginOpensThePageTakesTheCodeAndCompletes() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: false))
        let socket = ScriptedSocket()
        let flow = ClaudeLoginFlow(backend: backend, makeSocket: { socket }, pollInterval: .milliseconds(10))
        flow.start()
        #expect(flow.phase == .preparing)
        socket.push(#"{"type":"output","data":"Welcome"}"#)
        socket.push(#"{"type":"auth_url","url":"https://claude.ai/oauth/authorize?x=1"}"#)
        let page = try #require(URL(string: "https://claude.ai/oauth/authorize?x=1"))
        try await until { flow.phase == .ready(page) }
        flow.submit("  code#123  ")
        #expect(flow.phase == .submitting(page))
        try await until { socket.sent.count == 1 }
        #expect(socket.sent.first?.contains(#""type":"submit_code""#) == true)
        #expect(socket.sent.first?.contains(#""code":"code#123""#) == true)
        // A refused code: paste again.
        socket.push(#"{"type":"auth_error","message":"Invalid code"}"#)
        try await until { flow.codeRejected && flow.phase == .ready(page) }
        flow.submit("good")
        #expect(!flow.codeRejected)
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: true))
        try await until { flow.phase == .connected }
        #expect(socket.closed)
    }

    @Test func aClaudeLoginWhosePageNeverComesTimesOut() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: false))
        let socket = ScriptedSocket()
        let flow = ClaudeLoginFlow(backend: backend, makeSocket: { socket }, prepareTimeout: .milliseconds(30), pollInterval: .seconds(10))
        flow.start()
        try await until { flow.phase == .failed(.timedOut) }
        #expect(socket.closed)
    }

    @Test func aClaudeLoginWhoseSocketClosesSaysSo() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: false))
        let socket = ScriptedSocket()
        let flow = ClaudeLoginFlow(backend: backend, makeSocket: { socket }, pollInterval: .seconds(10))
        flow.start()
        socket.push(#"{"type":"auth_url","url":"https://claude.ai/a"}"#)
        socket.finish()
        try await until { flow.phase == .failed(.closed) }
        // Try again opens a new socket.
        let second = ScriptedSocket()
        let retry = ClaudeLoginFlow(backend: backend, makeSocket: { second }, pollInterval: .seconds(10))
        retry.start()
        #expect(retry.phase == .preparing)
        retry.stop()
        #expect(second.closed)
    }

    @Test func aClaudeLoginThatLandsAsTheSocketClosesStillCompletes() async throws {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: true))
        let socket = ScriptedSocket()
        let flow = ClaudeLoginFlow(backend: backend, makeSocket: { socket }, pollInterval: .seconds(10))
        flow.start()
        socket.push(#"{"type":"exit","code":0}"#)
        socket.finish()
        try await until { flow.phase == .connected }
    }

    @Test func aServerErrorOnTheSocketIsShown() async throws {
        let backend = FakeBackend()
        let socket = ScriptedSocket()
        let flow = ClaudeLoginFlow(backend: backend, makeSocket: { socket }, pollInterval: .seconds(10))
        flow.start()
        socket.push(#"{"type":"error","message":"Session timed out (5 min limit)"}"#)
        try await until { flow.phase == .failed(.server("Session timed out (5 min limit)")) }
    }

    @Test func theDemoClaudeLoginRefusesWrongAndTakesAnyOtherCode() async throws {
        // The demo's socket with no beats, over a backend the login flips.
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: false))
        let socket = DemoLoginSocket(beat: .zero, check: .zero) {
            backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: true))
        }
        let flow = ClaudeLoginFlow(backend: backend, makeSocket: { socket }, pollInterval: .milliseconds(10))
        flow.start()
        try await until { if case .ready = flow.phase { return true } else { return false } }
        flow.submit("wrong")
        try await until { flow.codeRejected }
        #expect(backend.aiStatus?.claude?.loggedIn == false)
        flow.submit("abc123")
        try await until { flow.phase == .connected }
    }

    // MARK: Chat's connect card

    // MARK: The default's dialogs

    private func state(_ provider: DefaultModelProvider?, claude: Bool, chatgpt: Bool, credits: Bool = false, following: Int = 2) -> AIToolsStatus.DefaultState {
        .init(provider: provider, signedIn: .init(anthropic: claude, openai: chatgpt), romeCreditsUsable: credits, followingChats: following)
    }

    @Test func settingTheDefaultAsksWhetherChatsMoveWhileAnyFollow() {
        let dialog = AIDefaultDialog.setDefault(.anthropic, state: state(.openai, claude: true, chatgpt: true))
        #expect(dialog.title == "Make Claude the default?")
        #expect(dialog.message == "New chats use Claude." + "\n\nChats where you picked a model keep it.")
        #expect(dialog.choices == [.moveAll, .keepChats])
        #expect(dialog.label(.moveAll) == "Switch all chats")
        #expect(dialog.label(.keepChats) == "Only new chats")
        #expect(!AIDefaultDialog.Choice.keepChats.moveExisting)
        // No chat follows it: nothing to ask.
        let none = AIDefaultDialog.setDefault(.anthropic, state: state(.openai, claude: true, chatgpt: true, following: 0))
        #expect(none.choices == [.only(destructive: false)])
        #expect(none.label(.only(destructive: false)) == "Make default")
    }

    @Test func loggingOutOfTheDefaultNamesTheNextOne() {
        let dialog = AIDefaultDialog.logOut(.chatgpt, state: state(.openai, claude: true, chatgpt: true), otherExpired: false)
        #expect(dialog.title == "Log out of ChatGPT?")
        #expect(dialog.message == "Claude becomes the default." + "\n\nChats where you picked a model keep it.")
        #expect(dialog.choices == [.moveAll, .keepChats])
        #expect(dialog.label(.moveAll) == "Log out and switch all chats")
        #expect(dialog.label(.keepChats) == "Log out, keep chats here")
        // An expired login still takes it, and the dialog warns.
        let expired = AIDefaultDialog.logOut(.chatgpt, state: state(.openai, claude: true, chatgpt: true), otherExpired: true)
        #expect(expired.message == "Claude becomes the default. Its login has expired: log in to Claude again after you log out." + "\n\nChats where you picked a model keep it.")
        // No chat follows it: one Log out.
        #expect(AIDefaultDialog.logOut(.chatgpt, state: state(.openai, claude: true, chatgpt: true, following: 0), otherExpired: false).choices == [.only(destructive: false)])
    }

    @Test func theLastLogoutHandsTheDefaultToCreditsOrPauses() {
        let credits = AIDefaultDialog.logOut(.chatgpt, state: state(.openai, claude: false, chatgpt: true, credits: true), otherExpired: false)
        #expect(credits.message == "Rome credits become the default." + "\n\nChats where you picked a model keep it.")
        #expect(credits.choices == [.moveAll, .keepChats])
        let pause = AIDefaultDialog.logOut(.chatgpt, state: state(.openai, claude: false, chatgpt: true), otherExpired: false)
        #expect(pause.message == "Chats pause until you log in again.")
        #expect(pause.choices == [.only(destructive: true)])
    }

    @Test func loggingOutOfTheOtherAccountMovesNothing() {
        let dialog = AIDefaultDialog.logOut(.claude, state: state(.openai, claude: true, chatgpt: true), otherExpired: false)
        #expect(dialog.message == "Chats on Claude will ask you to log in again.")
        #expect(dialog.choices == [.only(destructive: false)])
    }

    @Test func thePageOffersTheDefaultAndSendsTheChoice() async {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: true), codex: Provider(loggedIn: true), defaultProvider: state(.openai, claude: true, chatgpt: true))
        let store = AIModelStore(backend: backend)
        await store.refresh()
        #expect(store.offersDefault(.claude))
        #expect(!store.offersDefault(.chatgpt))
        #expect(!store.showsCredits)
        await store.setDefault(.anthropic, moveExisting: false)
        #expect(backend.defaultCalls.map(\.provider) == [.anthropic])
        #expect(backend.defaultCalls.first?.moveExisting == false)
        await store.logOut(.chatgpt, moveExisting: false)
        #expect(backend.logOutCalls.first?.moveExisting == false)
    }

    @Test func creditsShowWithNoAccountWhileTheyCouldRun() async {
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: false), codex: Provider(loggedIn: false), defaultProvider: state(nil, claude: false, chatgpt: false, credits: true))
        let store = AIModelStore(backend: backend)
        await store.refresh()
        #expect(store.showsCredits)
        #expect(store.summary == .notSetUp)
    }

    @Test func theConnectCardIsDrawnHereAndKeepsItsAnswer() {
        let card: [String: Any] = ["type": "pending_interaction", "toolUseId": "tu-ai", "appId": "rome", "render": ["componentId": "ai-tools-card", "builtin": true]]
        let content = String(data: try! JSONSerialization.data(withJSONObject: [card]), encoding: .utf8)!
        let message = ChatMessage(id: "m", sessionId: "s", role: "assistant", content: content, createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000)))
        func row(_ answers: [String: JSONValue]) -> TranscriptRow? {
            TranscriptBuilder.rows(messages: [message], pending: [], answers: answers, options: .init()).last
        }
        #expect(row([:]) == .aiTools(id: "m:0", toolUseId: "tu-ai", sessionId: "s", done: false))
        #expect(row(["m": .object(["connected": .bool(true)])]) == .aiTools(id: "m:0", toolUseId: "tu-ai", sessionId: "s", done: true))
    }

    @Test func aCardIsAnsweredOnce() async {
        let backend = FakeBackend()
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        async let first: Void = store.answerCard(toolUseId: "tu", sessionId: "s", output: .object(["connected": .bool(true)]))
        async let second: Void = store.answerCard(toolUseId: "tu", sessionId: "s", output: .object(["connected": .bool(true)]))
        _ = await (first, second)
        #expect(backend.answeredCards.count == 1)
        #expect(backend.answeredCards.first?.output == .object(["connected": .bool(true)]))
    }

    @Test func romeCreditsChosenWithNoAccountCompleteTheConnectCard() async {
        // Connect → Use Rome credits, then back to the card: credits run Chat.
        let backend = FakeBackend()
        backend.aiStatus = AIToolsStatus(claude: Provider(loggedIn: false), codex: Provider(loggedIn: false), defaultProvider: .init(provider: .romeCredits, romeCreditsUsable: true))
        let store = AIModelStore(backend: backend)
        await store.refresh()
        #expect(!store.hasLoggedInAccount)
        #expect(store.runsChats)
        #expect(AIToolsCard.answer(credits: true) == .object(["connected": .bool(true), "credits": .bool(true)]))
        #expect(AIToolsCard.answer(credits: false) == .object(["connected": .bool(true)]))
    }

    @Test func creditsAreOfferedOnlyAsTheServerAllows() {
        typealias State = AIToolsStatus.DefaultState
        // An expired login still counts as signed in: no credits.
        #expect(!AIModelStore.creditsEligible(State(provider: nil, signedIn: .init(anthropic: true, openai: false, romeCredits: false), romeCreditsUsable: true)))
        #expect(AIModelStore.creditsEligible(State(provider: nil, signedIn: .init(anthropic: false, openai: false, romeCredits: true), romeCreditsUsable: true)))
        // No balance, or the server says no.
        #expect(!AIModelStore.creditsEligible(State(provider: nil, signedIn: .init(anthropic: false, openai: false, romeCredits: false), romeCreditsUsable: true)))
        #expect(!AIModelStore.creditsEligible(State(provider: nil, signedIn: .init(anthropic: false, openai: false), romeCreditsUsable: false)))
    }

    @Test func aFailedCardAnswerOffersRetry() async {
        let backend = FakeBackend()
        backend.answerFails = true
        let store = TranscriptStore(sessionId: "s", kind: .concierge, backend: backend)
        await store.answerCard(toolUseId: "tu", sessionId: "s", output: AIToolsCard.answer(credits: false))
        #expect(store.failedCards.contains("tu"))
        #expect(!store.answeringCards.contains("tu"))
        backend.answerFails = false
        await store.answerCard(toolUseId: "tu", sessionId: "s", output: AIToolsCard.answer(credits: false))
        #expect(!store.failedCards.contains("tu"))
        #expect(backend.answeredCards.count == 1)
    }

    /// Waits up to ten seconds for `condition`: a loaded CI runner is slow.
    private func until(seconds: Int = 10, _ condition: () -> Bool) async throws {
        for _ in 0..<(seconds * 100) {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("Timed out")
    }
}

/// A login socket that hands out frames the test pushes.
@MainActor
final class ScriptedSocket: LoginSocket {
    private var frames: [String] = []
    private var ended = false
    private var waiting: CheckedContinuation<String?, Never>?
    private(set) var sent: [String] = []
    private(set) var closed = false

    func push(_ frame: String) {
        if let waiting {
            self.waiting = nil
            waiting.resume(returning: frame)
        } else {
            frames.append(frame)
        }
    }

    /// The server closes the socket.
    func finish() {
        ended = true
        if let waiting {
            self.waiting = nil
            waiting.resume(returning: nil)
        }
    }

    func receive() async throws -> String {
        if !frames.isEmpty { return frames.removeFirst() }
        if ended || closed { throw URLError(.networkConnectionLost) }
        let frame = await withCheckedContinuation { self.waiting = $0 }
        guard let frame else { throw URLError(.networkConnectionLost) }
        return frame
    }

    func send(_ text: String) async throws { sent.append(text) }

    func close() {
        closed = true
        finish()
    }
}
