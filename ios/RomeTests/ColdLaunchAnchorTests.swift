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
    private static func transcript(in view: UIView) -> UIScrollView? {
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
        // The composer, and the pill when it shows, are under the transcript.
        #expect(cached.bottomInset > (pill == .goesAway ? 110 : 60), "bottom inset: \(cached)")

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
