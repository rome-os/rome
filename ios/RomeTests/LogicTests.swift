import CoreGraphics
import Foundation
import Testing
@testable import Rome

private func task(_ id: String, _ state: TaskState, updated: Double, completed: Double? = nil, archived: Double? = nil, rank: Double? = nil) -> ConciergeTask {
    ConciergeTask(
        id: id, title: id, state: state, summary: nil, waitingOn: nil, dueAt: nil, rank: rank, chat: nil,
        sourceMessageId: nil, createdAt: updated, updatedAt: updated, completedAt: completed, archivedAt: archived, notSynced: nil
    )
}

@Suite struct TaskGroupingTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var nowMs: Double { now.timeIntervalSince1970 * 1000 }

    @Test func twoGroupsInOrderWithoutArchived() {
        let groups = TasksStore.group([
            task("done", .done, updated: nowMs, completed: nowMs),
            task("needs", .needsUser, updated: nowMs - 60_000),
            task("gone", .doing, updated: nowMs, archived: nowMs),
            task("doing", .doing, updated: nowMs),
            task("next", .next, updated: nowMs - 120_000),
            task("watching", .watching, updated: nowMs - 30_000),
        ], showAllDone: false, now: now)
        #expect(groups.map(\.key) == [.inProgress, .done])
        // Waiting on the guardian first, then the latest update.
        #expect(groups[0].tasks.map(\.id) == ["needs", "doing", "watching", "next"])
        #expect(groups[1].tasks.map(\.id) == ["done"])
    }

    @Test func onlyDoneLeavesTheProgressGroupOut() {
        let groups = TasksStore.group([task("done", .done, updated: nowMs, completed: nowMs)], showAllDone: false, now: now)
        #expect(groups.map(\.key) == [.done])
    }

    @Test func oldFinishedRowsHideBehindShowMore() {
        let old = nowMs - 10 * 86_400_000
        let groups = TasksStore.group([
            task("recent", .done, updated: nowMs, completed: nowMs),
            task("old", .done, updated: old, completed: old),
            task("dropped", .dropped, updated: old, completed: old),
        ], showAllDone: false, now: now)
        #expect(groups.first?.tasks.map(\.id) == ["recent"])
        #expect(groups.first?.hidden == 2)
        let all = TasksStore.group([task("old", .done, updated: old, completed: old)], showAllDone: true, now: now)
        #expect(all.first?.tasks.map(\.id) == ["old"])
    }

    @Test func severalWaitingOnesSortByLatestUpdate() {
        let groups = TasksStore.group([
            task("old", .needsUser, updated: 1),
            task("doing", .doing, updated: 5),
            task("new", .needsUser, updated: 3),
        ], showAllDone: false, now: now)
        #expect(groups.first?.tasks.map(\.id) == ["new", "old", "doing"])
    }

    @Test func theMutedLineSaysOneThing() {
        let waiting = task("w", .needsUser, updated: nowMs - 2 * 3_600_000)
        #expect(TasksStore.rowLine(waiting, status: .waiting, now: now) == "Waiting on you")
        let failed = task("f", .doing, updated: nowMs)
        #expect(TasksStore.rowLine(failed, status: .failed, now: now) == "Didn't finish")
        let doing = task("d", .doing, updated: nowMs - 2 * 3_600_000)
        #expect(TasksStore.rowLine(doing, status: .plain, now: now) == RelativeTime.ago(Date(timeIntervalSince1970: (nowMs - 2 * 3_600_000) / 1000), now: now))
        // A finished row counts from when it finished.
        let done = task("x", .done, updated: nowMs, completed: nowMs - 86_400_000)
        #expect(TasksStore.rowLine(done, status: .plain, now: now) == RelativeTime.ago(Date(timeIntervalSince1970: (nowMs - 86_400_000) / 1000), now: now))
    }

    @Test func rowStatusIsWaitingFailedOrPlain() {
        let failedChat = ChatSession(id: "c", name: "c", running: false, lastTurnFailed: true)
        let runningChat = ChatSession(id: "c", name: "c", running: true, lastTurnFailed: true)
        #expect(TasksStore.rowStatus(task("w", .needsUser, updated: 1), chat: nil) == .waiting)
        #expect(TasksStore.rowStatus(task("f", .doing, updated: 1), chat: failedChat) == .failed)
        #expect(TasksStore.rowStatus(task("r", .doing, updated: 1), chat: runningChat) == .plain)
        #expect(TasksStore.rowStatus(task("n", .next, updated: 1), chat: nil) == .plain)
        #expect(TasksStore.rowStatus(task("d", .done, updated: 1, completed: 1), chat: failedChat) == .plain)
    }

    @MainActor @Test func olderUpsertsAreIgnoredAndArchivedRowsLeave() {
        let store = TasksStore(backend: StubBackend())
        store.apply(task("x", .doing, updated: 10))
        store.apply(task("x", .needsUser, updated: 5))
        #expect(store.tasks.first?.state == .doing)
        store.apply(task("x", .done, updated: 20, archived: 20))
        #expect(store.tasks.isEmpty)
    }
}

@Suite struct MarkdownTests {
    @Test func parsesBlocks() {
        let blocks = MarkdownParser.parse("""
        # Title

        Para one
        line two

        - a
        - b

        1. x
        2. y

        > quoted

        ```swift
        let a = 1
        ```
        ---
        """)
        #expect(blocks == [
            .heading(level: 1, text: "Title"),
            .paragraph("Para one\nline two"),
            .list(ordered: false, start: 1, items: ["a", "b"]),
            .list(ordered: true, start: 1, items: ["x", "y"]),
            .quote("quoted"),
            .code(language: "swift", text: "let a = 1"),
            .rule,
        ])
    }

    @Test func unterminatedCodeStillRenders() {
        #expect(MarkdownParser.parse("```\nabc") == [.code(language: nil, text: "abc")])
    }

    @Test func plainDropsMarks() {
        #expect(MarkdownParser.plain("**bold** and `code`") == "bold and code")
    }
}

@Suite struct AuthTests {
    let issuer = URL(string: "https://romeos.cc")!

    @Test func acceptsAMatchingCallback() throws {
        let url = URL(string: "cc.romeos.mobile:/oauth/callback?code=abc&state=s1&iss=https://romeos.cc")!
        #expect(try CloudAuth.code(from: url, state: "s1", issuer: issuer) == "abc")
    }

    @Test func rejectsWrongStateIssuerOrError() {
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "cc.romeos.mobile:/oauth/callback?code=abc&state=other&iss=https://romeos.cc")!, state: "s1", issuer: issuer)
        }
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "cc.romeos.mobile:/oauth/callback?code=abc&state=s1&iss=https://evil.example")!, state: "s1", issuer: issuer)
        }
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "cc.romeos.mobile:/oauth/callback?error=access_denied&state=s1&iss=https://romeos.cc")!, state: "s1", issuer: issuer)
        }
        #expect(throws: AuthError.self) {
            try CloudAuth.code(from: URL(string: "evil:/oauth/callback?code=abc&state=s1&iss=https://romeos.cc")!, state: "s1", issuer: issuer)
        }
    }

    @Test func base64URLHasNoPadding() {
        #expect(CloudAuth.base64URL(Data([0xFB, 0xFF])) == "-_8")
    }

    @Test func approvalStatusFollowsTheRecord() {
        #expect(ApprovalStatus.derive(stored: "pending", record: nil) == .pending)
        #expect(ApprovalStatus.derive(stored: "pending", record: ApprovalRecord(id: "a", status: "approved", executionState: "running")) == .executing)
        #expect(ApprovalStatus.derive(stored: "pending", record: ApprovalRecord(id: "a", status: "approved", executionState: "succeeded")) == .executed)
        #expect(ApprovalStatus.derive(stored: "pending", record: ApprovalRecord(id: "a", status: "rejected")) == .rejected)
    }

    @Test func toolCallsReadRunsAndBlocks() {
        let segments: [JSONValue] = [
            .object(["kind": .string("run"), "blocks": .array([
                .object(["type": .string("tool_use"), "tool": .string("mcp__app__web_fetch"), "id": .string("1"), "input": .object(["url": .string("https://a")])]),
                .object(["type": .string("tool_result"), "tool": .string("web_fetch")]),
            ])]),
            .object(["kind": .string("block"), "block": .object(["type": .string("tool_use"), "tool": .string("Bash"), "input": .object(["command": .string("ls\n-la")])])]),
        ]
        let calls = ToolCallExtractor.calls(in: segments)
        #expect(calls.map(\.name) == ["web_fetch", "Bash"])
        #expect(calls.map(\.detail) == ["https://a", "ls -la"])
    }
}

/// A backend that answers nothing, for stores under test.
@MainActor
final class StubBackend: RomeBackend {
    final class Events: LiveEventSource {
        func subscribe(_ topic: String, _ handler: @escaping @MainActor (LiveEvent) -> Void) -> UUID { UUID() }
        func unsubscribe(_ token: UUID) {}
        func pause() {}
        func resume() {}
    }

    let displayOrigin = "stub"
    let events: LiveEventSource = Events()
    func conciergeSession() async throws -> ConciergeSessionInfo { .init(id: "concierge", unread: 0) }
    func conciergeChats() async throws -> [ConciergeChat] { [] }
    func startTopicChat() async throws -> ConciergeChat { throw APIError.network }
    func renameChat(_ id: String, to name: String) async throws {}
    func archiveChat(_ id: String) async throws {}
    func messages(sessionId: String, before: String?, limit: Int) async throws -> MessagePage { .init(messages: []) }
    func send(sessionId: String, text: String, files: [OutgoingFile], inputId: String, priority: InputPriority) async throws -> CreatedTurn { .init() }
    func asset(path: String) async throws -> Data { throw APIError.notFound }
    func apiFile(path: String, query: String?) async throws -> Data { throw APIError.notFound }
    var origin: URL? { nil }
    func answer(sessionId: String, toolUseId: String, output: JSONValue) async throws {}
    func markRead(sessionId: String) async {}
    func sessions() async throws -> [ChatSession] { [] }
    func activeTurns(sessionId: String) async throws -> [ActiveTurn] { [] }
    func interrupt(turnId: String) async throws {}
    func tasks() async throws -> [ConciergeTask] { [] }
    func approval(id: String) async throws -> ApprovalRecord { .init(id: id, status: "pending") }
    func resolveApproval(id: String, approve: Bool) async throws {}
    func toolCalls(traceMessageId: String) async throws -> [ToolCall] { [] }
    func aiTools() async throws -> AIToolsStatus { .init() }
    func setConciergeEnabled(_ enabled: Bool) async throws {}
    func search(_ query: String) async throws -> [SearchHit] { [] }
    func me() async throws -> AccountIdentity? { nil }
    func sendFeedback(_ text: String) async throws {}
    func upgradeCheck() async throws -> UpgradeCheck { throw APIError.network }
    func startUpgrade(target: String) async throws -> UpgradeStarted { throw APIError.network }
    func buildInfo() async throws -> BuildInfo { throw APIError.network }
}

@Suite struct AppLanguageTests {
    /// Named in its own language, from what iOS resolved for the app.
    @Test func namesTheResolvedLanguage() {
        #expect(AppLanguage.name("zh-Hans") == "简体中文")
        #expect(AppLanguage.name("en") == "English")
        #expect(AppLanguage.name(nil) == "English")
    }
}

@MainActor
@Suite struct LanguageSyncTests {
    private func defaults() -> UserDefaults {
        let name = "language-sync-\(UUID().uuidString)"
        return UserDefaults(suiteName: name)!
    }

    @Test func mapsToTheDashboardsCodes() {
        #expect(LanguageSync.code("zh-Hans") == "zh-CN")
        #expect(LanguageSync.code("en") == "en")
        #expect(LanguageSync.code(nil) == "en")
    }

    /// A first run or a new instance only remembers: it never overwrites a
    /// choice made on another device.
    @Test func theFirstSightDoesNotWrite() async {
        let sync = LanguageSync(defaults: defaults())
        var writes: [String] = []
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(writes.isEmpty)
    }

    @Test func aChangeWritesOnceAndNoChangeDoesNot() async {
        let sync = LanguageSync(defaults: defaults())
        var writes: [String] = []
        await sync.check(host: "a", current: "en", isGuardian: { true }) { writes.append($0) }
        await sync.check(host: "a", current: "en", isGuardian: { true }) { writes.append($0) }
        #expect(writes.isEmpty)
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(writes == ["zh-CN"])
        // Each instance remembers its own.
        await sync.check(host: "b", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(writes == ["zh-CN"])
    }

    @Test func aFailedWriteIsTriedAgain() async {
        let sync = LanguageSync(defaults: defaults())
        var attempts = 0
        await sync.check(host: "a", current: "en", isGuardian: { true }) { _ in }
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { _ in
            attempts += 1
            throw APIError.network
        }
        var writes: [String] = []
        await sync.check(host: "a", current: "zh-CN", isGuardian: { true }) { writes.append($0) }
        #expect(attempts == 1)
        #expect(writes == ["zh-CN"])
    }

    @Test func aVisitorNeverWrites() async {
        let sync = LanguageSync(defaults: defaults())
        var writes: [String] = []
        await sync.check(host: "a", current: "en", isGuardian: { false }) { writes.append($0) }
        await sync.check(host: "a", current: "zh-CN", isGuardian: { false }) { writes.append($0) }
        #expect(writes.isEmpty)
    }
}

@Suite struct AppLinksTests {
    private let origin = URL(string: "https://me.romeos.cc")!

    /// Only what the guardian made or installed: as the web splits them.
    @Test func leavesOutBuiltinAndHiddenApps() {
        let apps = [
            InstalledApp(id: "habits", origin: "local"),
            InstalledApp(id: "packing", origin: "appstore"),
            InstalledApp(id: "browser-automation", origin: "builtin"),
            InstalledApp(id: "quiet", origin: "local", hideInLauncher: true),
            InstalledApp(id: "user-skills", origin: "local"),
            InstalledApp(id: "unknown"),
        ]
        #expect(AppLinks.mine(apps).map(\.id) == ["habits", "packing"])
    }

    @Test func buildsTheFullScreenURL() {
        #expect(AppLinks.fullURL(origin: origin, app: InstalledApp(id: "habits", fullHref: "/full/apps/habits"))?.absoluteString == "https://me.romeos.cc/full/apps/habits")
        // Without a href, built as the server builds it.
        #expect(AppLinks.fullURL(origin: origin, app: InstalledApp(id: "my app"))?.absoluteString == "https://me.romeos.cc/full/apps/my%20app")
        // A href that is not a path never sends the view elsewhere.
        #expect(AppLinks.fullURL(origin: origin, app: InstalledApp(id: "x", fullHref: "https://evil.example/x"))?.host() == "me.romeos.cc")
    }

    /// The session goes to the instance alone; every other site opens in Safari.
    @Test func onlyTheInstanceStaysInTheWebView() {
        #expect(AppLinks.staysInApp(URL(string: "https://me.romeos.cc/full/apps/x/page")!, origin: origin))
        #expect(AppLinks.staysInApp(URL(string: "https://ME.romeos.cc:443/api/apps")!, origin: origin))
        #expect(!AppLinks.staysInApp(URL(string: "https://other.romeos.cc/")!, origin: origin))
        #expect(!AppLinks.staysInApp(URL(string: "http://me.romeos.cc/")!, origin: origin))
        #expect(!AppLinks.staysInApp(URL(string: "https://me.romeos.cc:8443/")!, origin: origin))
        #expect(!AppLinks.staysInApp(URL(string: "mailto:a@b.c")!, origin: origin))
        #expect(AppLinks.staysInApp(URL(string: "about:blank")!, origin: origin))
    }

    @Test func theSessionCookieIsScopedToTheInstance() throws {
        let client = APIClient(origin: origin, token: { "t" })
        let cookie = try #require(client.sessionCookie())
        #expect(cookie.name == "rome_session" && cookie.value == "t")
        #expect(cookie.domain == "me.romeos.cc")
        #expect(cookie.path == "/")
        #expect(cookie.isSecure)
        #expect(APIClient(origin: origin, token: { nil }).sessionCookie() == nil)
    }

    @Test func eachIdeaIsAReadyPrompt() {
        #expect(AppIdea.habitTracker.prompt == "Make me an app: a habit tracker")
        #expect(AppIdea.packingList.prompt == "Make me an app: a trip packing list")
        #expect(AppIdea.readingLog.prompt == "Make me an app: a reading log")
    }

    @Test func thePageFollowsTheAppsLookAndLanguage() {
        #expect(AppWebView.themeValue(.automatic) == "system")
        #expect(AppWebView.themeValue(.dark) == "dark")
        let script = AppWebView.settingsScript(theme: "dark", language: "zh-CN")
        #expect(script.contains(#"localStorage.setItem("rome-theme", "dark")"#))
        #expect(script.contains(#"localStorage.setItem("rome.lang", "zh-CN")"#))
    }
}

@Suite struct PushPresentationTests {
    private func target(_ chat: String?, instance: String = "i1") -> PushTarget { PushTarget(instanceId: instance, chatId: chat) }

    /// The chat on screen has the reply already: no banner. Any other shows one.
    @Test func noBannerForTheChatOnScreen() {
        #expect(!PushPresentation.shows(target("topic-1"), visibleChat: "topic-1", instanceID: "i1", mainServerID: nil))
        #expect(PushPresentation.shows(target("topic-2"), visibleChat: "topic-1", instanceID: "i1", mainServerID: nil))
        // Nothing on screen (a sheet, the drawer): it shows.
        #expect(PushPresentation.shows(target("topic-1"), visibleChat: nil, instanceID: "i1", mainServerID: nil))
        // Another instance's push always shows.
        #expect(PushPresentation.shows(target("topic-1", instance: "i2"), visibleChat: "topic-1", instanceID: "i1", mainServerID: nil))
    }

    /// The server names the main chat by its own id; the app by `concierge`.
    @Test func theMainChatMatchesByEitherName() {
        #expect(!PushPresentation.shows(target("c-42"), visibleChat: conciergeChatID, instanceID: "i1", mainServerID: "c-42"))
        #expect(!PushPresentation.shows(target(nil), visibleChat: conciergeChatID, instanceID: "i1", mainServerID: "c-42"))
        #expect(PushPresentation.shows(target("c-42"), visibleChat: "topic-1", instanceID: "i1", mainServerID: "c-42"))
    }

    @Test func openingAChatClearsOnlyItsOwn() {
        let reply: [AnyHashable: Any] = ["rome": ["instanceId": "i1", "chatId": "topic-1"]]
        let other: [AnyHashable: Any] = ["rome": ["instanceId": "i1", "chatId": "topic-2"]]
        let elsewhere: [AnyHashable: Any] = ["rome": ["instanceId": "i2", "chatId": "topic-1"]]
        #expect(PushPresentation.belongs(reply, to: "topic-1", instanceID: "i1", mainServerID: nil))
        #expect(!PushPresentation.belongs(other, to: "topic-1", instanceID: "i1", mainServerID: nil))
        #expect(!PushPresentation.belongs(elsewhere, to: "topic-1", instanceID: "i1", mainServerID: nil))
        #expect(!PushPresentation.belongs([:], to: "topic-1", instanceID: "i1", mainServerID: nil))
    }

    /// The server counts only the phone's socket as watching, by this header.
    @Test func theSocketSaysItIsThePhone() {
        let request = APIClient(origin: URL(string: "https://me.romeos.cc")!, token: { "t" }).socketRequest("/ws/events")
        #expect(request.value(forHTTPHeaderField: "x-rome-client") == "phone")
    }

    @Test func theGateKnowsWhenTheAppIsAway() {
        var gate = ForegroundGate()
        #expect(!gate.isInBackground)
        gate.enteredBackground(at: .now)
        #expect(gate.isInBackground)
        _ = gate.becameActive(at: .now)
        #expect(!gate.isInBackground)
    }
}

@Suite struct ChatWatchTests {
    /// The watch follows the chat on screen: one chat at a time, none under a sheet.
    @Test func followsTheChatOnScreen() {
        var watch = ChatWatch()
        #expect(watch.move(to: "topic-b").map(\.topic) == ["chat.watch:topic-b"])
        #expect(watch.move(to: "topic-b").isEmpty)
        let moved = watch.move(to: "c-42")
        #expect(moved.map(\.type) == ["unsubscribe", "subscribe"])
        #expect(moved.map(\.topic) == ["chat.watch:topic-b", "chat.watch:c-42"])
        #expect(watch.topic == "chat.watch:c-42")
        #expect(watch.move(to: nil).map(\.topic) == ["chat.watch:c-42"])
        #expect(watch.topic == nil)
    }

    /// A new connection sends the watch before every data topic, so the
    /// server's cap on those never refuses it.
    @Test func connectsWithTheWatchFirst() {
        var watch = ChatWatch()
        let topics: Set<String> = (0..<40).reduce(into: []) { $0.insert(LiveTopic.chat("s-\($1)")) }
        #expect(watch.connecting(topics).count == 40)
        _ = watch.move(to: "c-42")
        let frames = watch.connecting(topics)
        #expect(frames.first == "chat.watch:c-42")
        #expect(frames.count == 41)
    }

    /// A view replaced by a new one leaves the new one's chat on screen.
    @Test func aReplacedViewKeepsTheNewViewsChat() {
        var screen = ScreenChat()
        let old = UUID(), new = UUID()
        screen.show("concierge", by: old)
        screen.show("concierge", by: new)
        screen.hide(by: old)
        #expect(screen.chat == "concierge")
        screen.hide(by: new)
        #expect(screen.chat == nil)
    }

    /// The main chat is watched by the server's own id once it is known.
    @Test func watchesTheMainChatByItsServerID() {
        #expect(PushPresentation.serverChat(conciergeChatID, mainServerID: "c-42") == "c-42")
        #expect(PushPresentation.serverChat(conciergeChatID, mainServerID: nil) == conciergeChatID)
        #expect(PushPresentation.serverChat("topic-b", mainServerID: "c-42") == "topic-b")
        #expect(PushPresentation.serverChat(nil, mainServerID: "c-42") == nil)
    }
}

@Suite struct AppTileTests {
    /// A name keeps its color on every launch, whatever its case.
    @Test func aNameKeepsItsColor() {
        #expect(AppTile.colorIndex(for: "Habit tracker") == AppTile.colorIndex(for: "Habit tracker"))
        #expect(AppTile.colorIndex(for: "Habit tracker") == AppTile.colorIndex(for: "habit TRACKER"))
        // Fixed values: a change to the hash would recolor every app.
        #expect(AppTile.colorIndex(for: "", count: 6) == 2_166_136_261 % 6)
        #expect(AppTile.colorIndex(for: "a", count: 6) == Int(((2_166_136_261 ^ 97) &* 16_777_619 as UInt32) % 6))
    }

    /// Apps spread over the palette rather than all taking one color.
    @Test func appsSpreadOverThePalette() {
        let names = ["记账本", "Recipes", "Workout plan", "家庭相册", "Plant care", "Budget", "单词卡片", "Meal planner", "Kyoto trip", "Movie night"]
        let indexes = names.map { AppTile.colorIndex(for: $0) }
        #expect(indexes.allSatisfy { (0..<Palette.appTiles.count).contains($0) })
        #expect(Set(indexes).count >= 4)
    }
}

@Suite struct ComposerPrefillTests {
    /// An empty composer takes the prompt as it is, the blank start's trailing space too.
    @Test func anEmptyComposerTakesThePrompt() {
        #expect(ComposerPrefill.merged(draft: "", prompt: "Make an app: ") == "Make an app: ")
        #expect(ComposerPrefill.merged(draft: "  \n", prompt: "Make me an app: a reading log") == "Make me an app: a reading log")
    }

    /// A draft is never overwritten: the prompt goes after it on a new line.
    @Test func aDraftStaysAndThePromptFollows() {
        #expect(ComposerPrefill.merged(draft: "Remind me at 6\n", prompt: "Make me an app: a habit tracker")
            == "Remind me at 6\nMake me an app: a habit tracker")
    }

    /// A second tap on the same idea does not add it again.
    @Test func aSecondTapAddsNothing() {
        let once = ComposerPrefill.merged(draft: "Hi", prompt: "Make an app: ")
        #expect(ComposerPrefill.merged(draft: once, prompt: "Make an app: ") == once)
    }

    /// The blank start comes first, before the three ideas, and each prompt is unsent text.
    @Test func theBlankStartComesFirst() {
        #expect(AppIdea.allCases.first == .own)
        #expect(AppIdea.allCases.count == 4)
        #expect(AppIdea.own.prompt.hasSuffix(" ") || AppIdea.own.prompt.hasSuffix("："))
    }
}

@Suite struct ChatLinkTests {
    private static let origin = URL(string: "https://me.romeos.cc")!
    private static let apps = [
        InstalledApp(id: "habit-tracker", displayName: "Habit Tracker", fullHref: "/full/apps/habit-tracker", origin: "local"),
        InstalledApp(id: "notes", displayName: "Notes", fullHref: "/custom/notes-page", origin: "appstore"),
    ]

    private func link(_ text: String, origin: URL? = ChatLinkTests.origin) throws -> AppLinks.ChatLink {
        AppLinks.chatLink(try #require(URL(string: text)), origin: origin, apps: Self.apps)
    }

    /// `/apps/<id>` as the Concierge writes it, the full page, and the same on the origin open the app.
    @Test func appLinksOpenTheApp() throws {
        let page = URL(string: "https://me.romeos.cc/apps/habit-tracker")
        #expect(try link("/apps/habit-tracker") == .app(id: "habit-tracker", page: page))
        #expect(try link("/apps/habit-tracker/") == .app(id: "habit-tracker", page: URL(string: "https://me.romeos.cc/apps/habit-tracker/")))
        #expect(try link("https://me.romeos.cc/apps/habit-tracker") == .app(id: "habit-tracker", page: page))
        #expect(try link("/full/apps/habit-tracker") == .app(id: "habit-tracker", page: URL(string: "https://me.romeos.cc/full/apps/habit-tracker")))
        // An app's own fullHref, whatever its shape.
        #expect(try link("/custom/notes-page") == .app(id: "notes", page: URL(string: "https://me.romeos.cc/custom/notes-page")))
        // An app not in the list yet (just built) still names its id.
        #expect(try link("/apps/new-one") == .app(id: "new-one", page: URL(string: "https://me.romeos.cc/apps/new-one")))
        #expect(try link("/apps/my%20app") == .app(id: "my app", page: URL(string: "https://me.romeos.cc/apps/my%20app")))
    }

    /// Other paths on the instance open in the in-app web view.
    @Test func instancePagesStayInTheApp() throws {
        #expect(try link("/settings/models") == .page(URL(string: "https://me.romeos.cc/settings/models")!))
        #expect(try link("/apps") == .page(URL(string: "https://me.romeos.cc/apps")!))
        #expect(try link("/apps/a/b") == .page(URL(string: "https://me.romeos.cc/apps/a/b")!))
        #expect(try link("https://me.romeos.cc/chat/123") == .page(URL(string: "https://me.romeos.cc/chat/123")!))
        // No origin (demo data): a page has nowhere to resolve.
        #expect(try link("/settings", origin: nil) == .system)
        #expect(try link("/apps/habit-tracker", origin: nil) == .app(id: "habit-tracker", page: nil))
    }

    /// Other sites go to Safari, other schemes to the system.
    @Test func everythingElseLeavesTheApp() throws {
        #expect(try link("https://example.com/apps/habit-tracker") == .external)
        #expect(try link("http://me.romeos.cc/apps/habit-tracker") == .external)
        #expect(try link("https://me.romeos.cc:8443/x") == .external)
        #expect(try link("mailto:lin@example.com") == .system)
        #expect(try link("tel:+123") == .system)
    }
}

@Suite struct RecentAppsTests {
    private static let apps = ["a", "b", "c", "d", "e", "f"].map { InstalledApp(id: $0, displayName: $0.uppercased(), origin: "local") }

    /// Newest first, each once, kept per instance.
    @Test func newestFirstPerInstance() throws {
        let suite = "rome-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let mine = RecentApps(host: "me.romeos.cc", defaults: defaults)
        mine.record("a")
        mine.record("b")
        mine.record("a")
        RecentApps(host: "team.romeos.cc", defaults: defaults).record("z")
        #expect(mine.ids() == ["a", "b"])
        #expect(RecentApps(host: "team.romeos.cc", defaults: defaults).ids() == ["z"])
    }

    /// At most four, only apps the list still has; none gives no group.
    @Test func picksFourTheListHas() {
        #expect(RecentApps.pick(["f", "gone", "a", "b", "c", "d"], from: Self.apps).map(\.id) == ["f", "a", "b", "c"])
        #expect(RecentApps.pick([], from: Self.apps).isEmpty)
        #expect(RecentApps.pick(["gone"], from: Self.apps).isEmpty)
    }
}

@Suite struct AccountIdentityTests {
    /// The guardian's display name, else "Guardian", as the web's profile menu reads it.
    @Test func guardianNameOrGuardian() {
        let named = AccountIdentity(json: .object(["kind": .string("guardian"), "userId": .string("0b7f9c"), "displayName": .string("Lin"), "avatarUrl": .string("https://lh3.example.com/a.png")]))
        #expect(named == AccountIdentity(name: "Lin", avatarURL: URL(string: "https://lh3.example.com/a.png")))
        // No name: never the user id, whose first character the avatar used to show.
        let unnamed = AccountIdentity(json: .object(["kind": .string("guardian"), "userId": .string("0b7f9c"), "displayName": .null, "avatarUrl": .null]))
        #expect(unnamed?.name == String(localized: "Guardian"))
        #expect(unnamed?.avatarURL == nil)
    }

    @Test func visitorEmailAndNothingElse() {
        #expect(AccountIdentity(json: .object(["kind": .string("visitor"), "email": .string("v@example.com"), "accountId": .string("x")]))?.name == "v@example.com")
        #expect(AccountIdentity(json: .object(["kind": .string("anonymous")])) == nil)
        // Only an https picture is loaded.
        #expect(AccountIdentity(json: .object(["kind": .string("guardian"), "avatarUrl": .string("http://x/a.png")]))?.avatarURL == nil)
    }
}

@Suite @MainActor struct AppIconImageTests {
    @Test func recognisesSVG() {
        #expect(AppIconImage.isSVG(Data(#"<svg xmlns="http://www.w3.org/2000/svg"/>"#.utf8)))
        #expect(AppIconImage.isSVG(Data("\n<?xml version=\"1.0\"?>\n<svg></svg>".utf8)))
        #expect(!AppIconImage.isSVG(Data([0x89, 0x50, 0x4E, 0x47])))
        #expect(!AppIconImage.isSVG(Data("<html></html>".utf8)))
    }
}

@Suite @MainActor struct SVGDrawTests {
    /// An SVG icon draws square and in place: its top corner is the SVG's own
    /// color, not the page under a safe-area inset.
    @Test func drawsInPlace() async throws {
        let svg = Data(##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#ff0000"/></svg>"##.utf8)
        let image = try #require(await AppIconImage.decode(svg, side: 60))
        #expect(image.size == CGSize(width: 60, height: 60))
        let cgImage = try #require(image.cgImage)
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try #require(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        // The top-left pixel, drawn into a 1×1 context.
        context.draw(cgImage, in: CGRect(x: 0, y: -CGFloat(cgImage.height - 1), width: CGFloat(cgImage.width), height: CGFloat(cgImage.height)))
        #expect(pixel[0] > 200 && pixel[1] < 60 && pixel[3] > 200, "top-left pixel \(pixel)")
    }
}
