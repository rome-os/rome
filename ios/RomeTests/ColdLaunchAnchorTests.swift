import Foundation
import SwiftUI
import Testing
@testable import Rome

/// The main Chat's scroll as the screen has it: how far its end lies from
/// the bottom of the view (0: the newest message rests above the composer;
/// below 0: a gap under it), and the insets around it.
private struct ScrollState: CustomStringConvertible {
    var offset: CGFloat
    var contentHeight: CGFloat
    var viewHeight: CGFloat
    var topInset: CGFloat
    var bottomInset: CGFloat

    /// The end's distance below the visible area; negative past the end.
    var toEnd: CGFloat { contentHeight + bottomInset - viewHeight - offset }

    var description: String {
        "offset \(offset), content \(contentHeight), view \(viewHeight), insets \(topInset)/\(bottomInset), to end \(toEnd)"
    }
}

/// A cold launch from kept rows, as the guardian met it: Chat opens on the
/// kept transcript, then the first fetch replaces it with the newest page
/// (older pages behind), the last message is a long reply that folds, and
/// the header gains a "waiting for you" status. Through all of it the
/// newest message rests just above the composer: no jump, no gap under it,
/// no space kept for a bar that is not shown.
@MainActor
@Suite(.serialized) struct ColdLaunchAnchorTests {
    static func transcript(in view: UIView) -> UIScrollView? {
        var best: UIScrollView?
        func walk(_ view: UIView) {
            if let scroll = view as? UIScrollView, !(scroll is UITextView), scroll.contentSize.height > (best?.contentSize.height ?? 0) {
                best = scroll
            }
            view.subviews.forEach(walk)
        }
        walk(view)
        return best
    }

    private static func state(_ scroll: UIScrollView) -> ScrollState {
        ScrollState(
            offset: scroll.contentOffset.y, contentHeight: scroll.contentSize.height, viewHeight: scroll.bounds.height,
            topInset: scroll.adjustedContentInset.top, bottomInset: scroll.adjustedContentInset.bottom
        )
    }

    /// How the update pill comes and goes in a launch.
    enum Pill: CaseIterable, Sendable {
        /// None shows.
        case none
        /// It shows from what was kept, and the launch's check takes it away
        /// while the fetch lands.
        case goesAway
        /// The update check answers late, after the kept rows and the fetch:
        /// the pill comes up then.
        case comesLate
    }

    /// The update the pill offers: newer than the instance, which is new
    /// enough for the app.
    private static let offered = InstanceUpdater.State.required(current: UpdateGate.minimumInstanceVersion, latest: "\(UpdateGate.minimumInstanceVersion).1", latestChanged: false)

    @Test(arguments: Pill.allCases)
    func theNewestMessageStaysAboveTheComposer(pill: Pill) async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "rome-cold-anchor-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        func drafts() -> DraftStore { DraftStore(root: root.appending(path: "Drafts"), instance: "t") }

        // An earlier run kept the main chat's newest rows on this phone.
        let demo = DemoBackend(variant: .longChat)
        let earlier = Workspace(backend: demo, instanceName: "T", host: "t", accountLabel: "t", drafts: drafts())
        let kept = try await demo.messages(sessionId: conciergeChatID, before: nil, limit: 40).messages
        earlier.transcripts.save(chat: conciergeChatID, messages: kept)
        earlier.transcripts.flush()
        TranscriptCache.settle()
        earlier.stop()

        // The cold launch: the kept rows show at once.
        let workspace = Workspace(backend: DemoBackend(variant: .longChat), instanceName: "T", host: "t", accountLabel: "t", drafts: drafts())
        defer { workspace.stop() }
        #expect(workspace.concierge.loaded && !workspace.concierge.messages.isEmpty)
        let model = AppModel()
        if pill == .goesAway {
            model.update.debugShow(Self.offered)
            #expect(model.update.showsBanner)
        }
        let host = UIHostingController(rootView: MainShell(workspace: workspace).environment(model))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
        }
        try await Task.sleep(for: .milliseconds(900))
        let scroll = try #require(Self.transcript(in: host.view))
        let cached = Self.state(scroll)
        #expect(abs(cached.toEnd) < 1, "kept rows: \(cached)")
        // The composer is under the transcript; the pill's own space is
        // checked against what follows.
        #expect(cached.bottomInset > 40, "bottom inset: \(cached)")

        // The fresh load, then the header's status; the check finds no update.
        if pill == .goesAway { model.update.debugShow(.upToDate) }
        await workspace.start()
        workspace.topics.setActivity(.needsYou, for: workspace.mainChatServerID ?? conciergeChatID)
        var samples: [ScrollState] = []
        var justAfterPill: ScrollState?
        // At least 4 s, then until the list holds still for half a second:
        // a busy CI simulator can stall for many seconds, so a fixed count
        // of samples could end before the fetch has landed.
        let deadline = Date.now.addingTimeInterval(30)
        var step = 0
        while step < 40 || (samples.suffix(5).contains { abs($0.toEnd - samples.last!.toEnd) > 0.5 || abs($0.bottomInset - samples.last!.bottomInset) > 0.5 } && Date.now < deadline) {
            // The late check's answer, a second after the fetch.
            if pill == .comesLate, step == 10 {
                model.update.debugShow(Self.offered)
                #expect(model.update.showsBanner)
                try await Task.sleep(for: .milliseconds(60))
                justAfterPill = Self.state(scroll)
            }
            try await Task.sleep(for: .milliseconds(100))
            samples.append(Self.state(scroll))
            step += 1
        }
        let settled = try #require(samples.last)
        #expect(workspace.concierge.hasOlder, "the fetch should page")
        #expect(abs(settled.toEnd) < 1, "after the fetch: \(settled)")
        // No space kept under the newest message beyond the composer's.
        switch pill {
        case .none:
            #expect(abs(settled.bottomInset - cached.bottomInset) < 1, "bottom inset \(cached.bottomInset) became \(settled.bottomInset)")
        case .goesAway:
            #expect(settled.bottomInset < cached.bottomInset - 20, "the pill's space should go: \(cached.bottomInset) → \(settled.bottomInset)")
        case .comesLate:
            #expect(settled.bottomInset > cached.bottomInset + 20, "the pill's space should come: \(cached.bottomInset) → \(settled.bottomInset)")
            // In place at once, with the bar: no motion of its own that the
            // transcript would have to chase.
            let early = try #require(justAfterPill)
            #expect(abs(early.bottomInset - settled.bottomInset) < 1 && abs(early.toEnd) < 1, "still moving 60 ms after the pill came: \(early), settled \(settled)")
        }
        // Never left past the end, the gap the guardian saw.
        let worst = samples.min { $0.toEnd < $1.toEnd }!
        #expect(worst.toEnd > -1, "a gap opened: \(worst)")
    }
}

@MainActor
@Observable
private final class Spacer83 {
    var height: CGFloat = 83
}

/// The transcript with a block under its last row that can shrink, as the
/// lazy stack's leftover guess did.
private struct ShrinkHost: View {
    let store: TranscriptStore
    let spacer: Spacer83

    var body: some View {
        TranscriptList(store: store, footer: AnyView(SpacerView(spacer: spacer))) { row, previous in
            Group {
                switch row {
                case .userText(_, let text, _, let pending): UserBubble(text: text, pending: pending)
                case .agentText(_, let text, _, let forwarded, let position): AgentBubble(text: text, forwardedFrom: forwarded, position: position)
                default: EmptyView()
                }
            }
            .padding(.top, TranscriptSpacing.top(row, after: previous))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { Color.gray.frame(height: 66) }
    }

    private struct SpacerView: View {
        let spacer: Spacer83
        var body: some View { Color.clear.frame(height: spacer.height) }
    }
}

/// Content that shrinks 83 pt under a list resting on the bottom, with no
/// touch: the list ends at the new bottom, with no gap left under it.
/// One turn of the main run loop, without waiting for anything.
private func runLoopTurn() {
    RunLoop.main.run(mode: .default, before: .now)
}

@MainActor
@Suite(.serialized) struct ShrinkAtRestTests {
    @Test func aShrinkAtRestLeavesNoGap() async throws {
        let backend = FakeBackend()
        backend.stored = (0..<40).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<1000 where !store.loaded { await Task.yield() }
        #expect(store.loaded)
        let spacer = Spacer83()
        let host = UIHostingController(rootView: ShrinkHost(store: store, spacer: spacer))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }
        // Layout passes, not time: each turn lets SwiftUI apply its updates
        // and lays the window out, until the list is where it should be or
        // the passes run out. A slow machine only takes more turns.
        func settle(_ done: () -> Bool) async {
            for _ in 0..<400 {
                window.layoutIfNeeded()
                if done() { return }
                await Task.yield()
                runLoopTurn()
            }
        }
        var scroll: UIScrollView?
        await settle {
            scroll = ColdLaunchAnchorTests.transcript(in: host.view)
            return (scroll?.contentSize.height ?? 0) > (scroll?.bounds.height ?? .infinity)
        }
        let list = try #require(scroll)
        func toEnd() -> CGFloat { list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height - list.contentOffset.y }
        await settle { abs(toEnd()) < 1 }
        #expect(abs(toEnd()) < 1, "settled: \(toEnd())")
        let before = list.contentSize.height

        spacer.height = 0
        await settle { list.contentSize.height < before - 80 && abs(toEnd()) < 1 }
        #expect(list.contentSize.height < before - 80, "the content did not shrink: \(before) → \(list.contentSize.height)")
        #expect(abs(toEnd()) < 1, "after an 83 pt shrink at rest: \(toEnd())")
    }
}


@MainActor
private final class Appearances {
    var count: [String: Int] = [:]
    var frames: [String: CGRect] = [:]
    /// Each row's top within the transcript's content.
    var tops: [String: CGFloat] = [:]

    /// Where `id` shows on screen: its top in the content less the scroll
    /// view's own offset, which is what is drawn. SwiftUI's global frame
    /// catches up with an offset set on the scroll view one update later.
    func shown(_ id: String, in scroll: UIScrollView) -> CGFloat? {
        tops[id].map { $0 - scroll.contentOffset.y }
    }
}

/// The transcript, counting how often each row comes on screen: a row the
/// stack rebuilds comes on again.
private struct AppearHost: View {
    let store: TranscriptStore
    let seen: Appearances
    /// Rows that come in short and grow a moment later, as a reply's picture
    /// does once it loads.
    var grows: Set<String> = []
    /// Replies taller than the screen; they grow by 240 pt when `growth` is on.
    var tall: Set<String> = []
    /// Rows of 180 pt that grow to 420 pt when `growth` is on.
    var growOnCue: Set<String> = []
    var growth = Growth()

    var body: some View {
        TranscriptList(store: store) { row, previous in
            Group {
                if grows.contains(row.id) {
                    LateGrowingRow()
                } else if tall.contains(row.id) {
                    Color.gray.opacity(0.2).frame(height: growth.on ? 2240 : 2000)
                } else if growOnCue.contains(row.id) {
                    Color.gray.opacity(0.3).frame(height: growth.on ? 420 : 180)
                } else {
                    switch row {
                    case .userText(_, let text, _, let pending): UserBubble(text: text, pending: pending)
                    case .agentText(_, let text, _, let forwarded, let position): AgentBubble(text: text, forwardedFrom: forwarded, position: position)
                    default: EmptyView()
                    }
                }
            }
            .onAppear { seen.count[row.id, default: 0] += 1 }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { seen.frames[row.id] = $0 }
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("transcriptContent")).minY } action: { seen.tops[row.id] = $0 }
            .padding(.top, TranscriptSpacing.top(row, after: previous))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { Color.gray.frame(height: 66) }
    }
}

/// A cold launch from kept rows, then the first fetch finding older pages:
/// the stack keeps its kind while the list follows the bottom. Switching it
/// rebuilt every row a moment after launch, and the new stack's guessed
/// heights left a gap under the last message until the next touch.
@MainActor
@Suite(.serialized) struct LaunchStackTests {
    @Test func theFetchDoesNotRebuildTheRows() async throws {
        let messages = (0..<120).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index / 2)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let root = FileManager.default.temporaryDirectory.appending(path: "rome-launch-stack-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = TranscriptCache(root: root, instance: "t")
        cache.save(chat: "chat-1", messages: messages)

        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.cache = cache
        store.showCached()
        let seen = Appearances()
        let host = UIHostingController(rootView: AppearHost(store: store, seen: seen))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }
        try await Task.sleep(for: .milliseconds(800))
        let last = "m119:0"
        #expect(seen.count[last] == 1)

        store.start()
        for _ in 0..<100 where !store.hasOlder { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.hasOlder)
        try await Task.sleep(for: .milliseconds(800))
        #expect(seen.count[last] == 1, "the last message came on \(seen.count[last] ?? 0) times: the stack was rebuilt")
        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        let toEnd = scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height - scroll.contentOffset.y
        #expect(abs(toEnd) < 1, "not at the bottom: \(toEnd)")
    }
}

/// Turns on the growth of `AppearHost`'s rows that grow on cue.
@MainActor @Observable
private final class Growth {
    var on = false
}

/// 180 pt, then 420 pt 0.4 s after it first shows: a picture's placeholder,
/// then the picture.
private struct LateGrowingRow: View {
    @State private var loaded = false

    var body: some View {
        Color.gray.opacity(0.3)
            .frame(height: loaded ? 420 : 180)
            .task {
                try? await Task.sleep(for: .milliseconds(400))
                loaded = true
            }
    }
}

/// Paging up: an older page lands above the rows on screen, which stay
/// where they are.
@MainActor
@Suite(.serialized) struct PagingUpTests {
    @Test func anOlderPageLandsAboveWithoutMovingTheRowsInView() async throws {
        let messages = (0..<160).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index / 2)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }
        let seen = Appearances()
        let host = UIHostingController(rootView: AppearHost(store: store, seen: seen))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }
        try await Task.sleep(for: .milliseconds(800))
        // On the bottom with older pages behind. A chat this short is within
        // reach of its top, so it may have fetched one already, which waits
        // for the top.
        for _ in 0..<100 where store.loadingOlder || store.placingOlder { try await Task.sleep(for: .milliseconds(10)) }
        let held = store.messages.count
        #expect(store.hasOlder && held >= TranscriptStore.pageSize)

        // Up to the top of what is held.
        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        // As a drag up does: the list stops following the bottom.
        NotificationCenter.default.post(name: PerfProbe.flingStarted, object: scroll)
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(100))
        let anchorId = try #require(seen.frames.filter { $0.value.minY > 200 && $0.value.minY < 600 }.min { $0.value.minY < $1.value.minY }?.key)
        let before = try #require(seen.shown(anchorId, in: scroll))

        for _ in 0..<200 where store.messages.count == held { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.messages.count > held, "no older page came")
        try await Task.sleep(for: .milliseconds(600))
        let after = try #require(seen.shown(anchorId, in: scroll))
        #expect(abs(after - before) < 1, "\(anchorId) moved from \(before) to \(after)")
    }

    /// A real page holds pictures and cards that take their height only
    /// after they show: the rows in view stay put through the whole insert,
    /// and after it, while those rows above grow.
    @Test func rowsAboveThatGrowLaterDoNotMoveTheRowsInView() async throws {
        let messages = (0..<160).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index / 2)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }
        let seen = Appearances()
        let grows = Set((0..<120).filter { $0 % 3 == 0 }.map { "m\($0):0" })
        let host = UIHostingController(rootView: AppearHost(store: store, seen: seen, grows: grows))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }
        try await Task.sleep(for: .milliseconds(800))
        for _ in 0..<200 where store.loadingOlder || store.placingOlder { try await Task.sleep(for: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(800))
        let held = store.messages.count

        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        // As a drag up does: the list stops following the bottom.
        NotificationCenter.default.post(name: PerfProbe.flingStarted, object: scroll)
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(100))
        let anchorId = try #require(seen.frames.filter { $0.value.minY > 200 && $0.value.minY < 600 }.min { $0.value.minY < $1.value.minY }?.key)
        let before = try #require(seen.shown(anchorId, in: scroll))

        // Every 10 ms through the insert and the growth after it.
        var worst: CGFloat = 0
        var steps = 0
        var last = before
        for _ in 0..<200 {
            try await Task.sleep(for: .milliseconds(10))
            let now = seen.shown(anchorId, in: scroll) ?? last
            worst = max(worst, abs(now - before))
            if abs(now - last) > 1 { steps += 1 }
            last = now
        }
        #expect(store.messages.count > held, "no older page came")
        #expect(worst < 1, "\(anchorId) strayed up to \(worst) pt from \(before), in \(steps) steps")
    }
}

/// A newest page that fits on one screen, with older pages behind it: no
/// scroll up can come near the top, so older pages load until it is full.
@MainActor
@Suite(.serialized) struct ShortPageTests {
    @Test func olderPagesFillAShortScreen() async throws {
        func message(_ index: Int, role: String) -> ChatMessage {
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index)", role: role, content: role == "trace" ? "[]" : "Message \(index), a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        // Thirty older messages, then a newest page of traces (no rows in a
        // Concierge chat) ending in two bubbles.
        let older = (0..<30).map { message($0, role: $0.isMultiple(of: 2) ? "user" : "assistant") }
        let newest = (30..<68).map { message($0, role: "trace") } + [message(68, role: "user"), message(69, role: "assistant")]
        let backend = FakeBackend()
        backend.stored = older + newest
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.hasOlder && store.messages.count == TranscriptStore.pageSize)

        let seen = Appearances()
        let host = UIHostingController(rootView: AppearHost(store: store, seen: seen))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
            store.stop()
        }
        for _ in 0..<200 where store.messages.count == TranscriptStore.pageSize { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.messages.count > TranscriptStore.pageSize, "no older page loaded under a short screen")
    }

    @Test func onlyAShortScreenWithOlderPagesAsks() {
        typealias List = TranscriptList<EmptyView>
        #expect(List.needsOlderToFill(hasOlder: true, rowsHeight: 300, visibleHeight: 640))
        #expect(!List.needsOlderToFill(hasOlder: false, rowsHeight: 300, visibleHeight: 640))
        #expect(!List.needsOlderToFill(hasOlder: true, rowsHeight: 2000, visibleHeight: 640))
        #expect(!List.needsOlderToFill(hasOlder: true, rowsHeight: 300, visibleHeight: 0))
        #expect(!List.needsOlderToFill(hasOlder: true, rowsHeight: 0, visibleHeight: 640))
    }
}


/// A reply taller than the screen fills it: the list is held by that reply,
/// not by a row off screen.
@MainActor
@Suite(.serialized) struct TallReplyTests {
    private func show(tall: Set<String>, growOnCue: Set<String>) async throws -> (TranscriptStore, Appearances, Growth, UIScrollView, UIWindow) {
        let messages = (0..<60).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index / 2)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let backend = FakeBackend()
        backend.stored = messages
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<100 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }
        let seen = Appearances()
        let growth = Growth()
        let host = UIHostingController(rootView: AppearHost(store: store, seen: seen, tall: tall, growOnCue: growOnCue, growth: growth))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.isHidden = false
        try await Task.sleep(for: .milliseconds(800))
        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        return (store, seen, growth, scroll, window)
    }

    /// Puts 300 pt of `id` above the visible area, so it fills the screen.
    private func scrollInto(_ id: String, seen: Appearances, scroll: UIScrollView) async throws {
        NotificationCenter.default.post(name: PerfProbe.flingStarted, object: scroll)
        let top = try #require(seen.tops[id])
        scroll.setContentOffset(CGPoint(x: 0, y: top + 300 - scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(300))
    }

    @Test func aTallReplyThatGrowsBelowTheScreenDoesNotMove() async throws {
        let (store, seen, growth, scroll, window) = try await show(tall: ["m50:0"], growOnCue: [])
        defer { window.isHidden = true; window.rootViewController = nil; window.windowScene = nil; store.stop() }
        try await scrollInto("m50:0", seen: seen, scroll: scroll)
        let before = try #require(seen.shown("m50:0", in: scroll))
        growth.on = true
        try await Task.sleep(for: .milliseconds(500))
        let after = try #require(seen.shown("m50:0", in: scroll))
        #expect(abs(after - before) < 1, "the reply in view moved from \(before) to \(after)")
    }

    @Test func aLastTallReplyStaysWhenRowsAboveGrow() async throws {
        let (store, seen, growth, scroll, window) = try await show(tall: ["m59:0"], growOnCue: Set((40..<58).map { "m\($0):0" }))
        defer { window.isHidden = true; window.rootViewController = nil; window.windowScene = nil; store.stop() }
        try await scrollInto("m59:0", seen: seen, scroll: scroll)
        let before = try #require(seen.shown("m59:0", in: scroll))
        growth.on = true
        try await Task.sleep(for: .milliseconds(500))
        let after = try #require(seen.shown("m59:0", in: scroll))
        #expect(abs(after - before) < 1, "the reply in view moved from \(before) to \(after)")
    }
}
