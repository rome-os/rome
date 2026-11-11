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
        for step in 0..<40 {
            // The late check's answer, a second after the fetch.
            if pill == .comesLate, step == 10 {
                model.update.debugShow(Self.offered)
                #expect(model.update.showsBanner)
                try await Task.sleep(for: .milliseconds(60))
                justAfterPill = Self.state(scroll)
            }
            try await Task.sleep(for: .milliseconds(100))
            samples.append(Self.state(scroll))
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
@MainActor
@Suite(.serialized) struct ShrinkAtRestTests {
    @Test func aShrinkAtRestLeavesNoGap() async throws {
        let backend = FakeBackend()
        backend.stored = (0..<40).map { index in
            ChatMessage(id: "m\(index)", sessionId: "chat-1", turnId: "t\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant", content: "Message \(index), long enough to fill a line or two of the bubble.", createdAt: RomeDate.string(Date(timeIntervalSince1970: 1_800_000_000 + Double(index * 60))))
        }
        let store = TranscriptStore(sessionId: "chat-1", kind: .concierge, backend: backend)
        store.start()
        for _ in 0..<50 where !store.loaded { try await Task.sleep(for: .milliseconds(10)) }
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
        try await Task.sleep(for: .milliseconds(800))
        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        func toEnd() -> CGFloat { scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height - scroll.contentOffset.y }
        #expect(abs(toEnd()) < 1, "settled: \(toEnd())")

        spacer.height = 0
        try await Task.sleep(for: .milliseconds(1500))
        #expect(abs(toEnd()) < 1, "after an 83 pt shrink at rest: \(toEnd())")
    }
}


@MainActor
private final class Appearances {
    var count: [String: Int] = [:]
    var frames: [String: CGRect] = [:]
}

/// The transcript, counting how often each row comes on screen: a row the
/// stack rebuilds comes on again.
private struct AppearHost: View {
    let store: TranscriptStore
    let seen: Appearances

    var body: some View {
        TranscriptList(store: store) { row, previous in
            Group {
                switch row {
                case .userText(_, let text, _, let pending): UserBubble(text: text, pending: pending)
                case .agentText(_, let text, _, let forwarded, let position): AgentBubble(text: text, forwardedFrom: forwarded, position: position)
                default: EmptyView()
                }
            }
            .onAppear { seen.count[row.id, default: 0] += 1 }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { seen.frames[row.id] = $0 }
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
        // On the bottom with older pages behind: nothing fetched yet.
        let held = store.messages.count
        #expect(store.hasOlder && held == TranscriptStore.pageSize)

        // Up to the top of what is held.
        let scroll = try #require(ColdLaunchAnchorTests.transcript(in: host.view))
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
        try await Task.sleep(for: .milliseconds(100))
        let anchorId = try #require(seen.frames.filter { $0.value.minY > 200 && $0.value.minY < 600 }.min { $0.value.minY < $1.value.minY }?.key)
        let before = try #require(seen.frames[anchorId]).minY

        for _ in 0..<200 where store.messages.count == held { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.messages.count > held, "no older page came")
        try await Task.sleep(for: .milliseconds(600))
        let after = try #require(seen.frames[anchorId]).minY
        #expect(abs(after - before) < 1, "\(anchorId) moved from \(before) to \(after)")
    }
}

