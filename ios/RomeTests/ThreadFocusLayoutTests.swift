import SwiftUI
import Testing
@testable import Rome

@MainActor
@Suite(.serialized) struct ThreadFocusLayoutTests {
    @Test(arguments: [CGFloat(180), CGFloat(470), CGFloat(700)])
    func firstLayoutKeepsTheAnchorInWindowCoordinates(y: CGFloat) async throws {
        let backend = FakeBackend()
        let messages = (0..<12).map { index in
            ChatMessage(id: "m\(index)", sessionId: "s", role: "user", content: "Message \(index)", createdAt: "2026-11-22T10:00:00Z", chatThreadId: "m0")
        }
        let focus = ThreadFocus(sessionId: "s", anchor: "m10", row: "m10:0", bubbleY: y, page: ThreadPage(messages: messages, hasOlder: true, hasNewer: false), backend: backend)
        let host = UIHostingController(rootView:
            TranscriptList(store: focus.transcript, alignTop: true, thread: focus) { row, previous in
                Text(row.id).frame(height: 70)
                    .padding(.top, TranscriptSpacing.top(row, after: previous))
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: 66) }
        )
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
        try await Task.sleep(for: .milliseconds(600))
        let list = try #require(ColdLaunchAnchorTests.transcript(in: host.view) as? UICollectionView)
        let cell = try #require(list.visibleCells.first { $0.accessibilityIdentifier == "m10:0" })
        let index = try #require(focus.transcript.rows.firstIndex { $0.id == "m10:0" })
        let gap = TranscriptSpacing.top(focus.transcript.rows[index], after: index > 0 ? focus.transcript.rows[index - 1] : nil)
        let actual = cell.convert(cell.bounds, to: nil).minY + gap
        #expect(abs(actual - y) < 1, "Expected bubble at \(y), got \(actual)")
        #expect(list.alpha == 1)
        #expect(backend.threadReads.isEmpty, "Opening focus must not page before the reader scrolls")
    }
}

@MainActor
@Suite(.serialized) struct ThreadFocusHandoffTests {
    private func descendants(_ view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap(descendants)
    }

    private func list(_ host: UIView, _ identifier: String) -> UICollectionView? {
        descendants(host).first { $0.accessibilityIdentifier == identifier } as? UICollectionView
    }

    private func bubbleY(_ list: UICollectionView, store: TranscriptStore, row: String) throws -> CGFloat {
        let cell = try #require(list.visibleCells.first { $0.accessibilityIdentifier == row })
        let at = try #require(store.rows.firstIndex { $0.id == row })
        return cell.convert(cell.bounds, to: nil).minY + TranscriptSpacing.top(store.rows[at], after: at > 0 ? store.rows[at - 1] : nil)
    }

    @Test(arguments: [CGFloat(180), CGFloat(440), CGFloat(660)], [8, 25])
    func cachedHandoffAndInverseKeepThePressedBubble(y: CGFloat, count: Int) async throws {
        try await exercise(y: y, count: count, width: 390)
    }

    @Test func wideLayoutKeepsOnePersistentComposer() async throws {
        try await exercise(y: 440, count: 25, width: 834)
    }

    @Test func reducedMotionCrossfadesWithoutMovingPictures() async throws {
        try await exercise(y: 440, count: 8, width: 390, reduced: true)
    }

    private func exercise(y: CGFloat, count: Int, width: CGFloat, reduced: Bool = false) async throws {
        let backend = FakeBackend()
        backend.mainChat = ConciergeSessionInfo(id: "concierge", unread: 0)
        struct Fixture: Decodable {
            let messages: [ChatMessage]
            let short: ThreadPage
            let long: ThreadPage
        }
        let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/reply-chain-seeded.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        func key(_ number: Int) -> String { String(format: "5eedc4a1-0000-4000-8000-%012d", number) }
        let target = key(count == 8 ? 29 : 47)
        let missing = key(count == 8 ? 12 : 36)
        let page = count == 8 ? fixture.short : fixture.long
        let root = try #require(page.messages.first?.chatThreadId)
        let chainIDs = Set(fixture.messages.filter { $0.chatThreadId == root }.map(\.id))
        let allIDs = Set(fixture.messages.map(\.id))
        #expect(chainIDs.count == count)
        backend.stored = fixture.messages.filter { $0.id != missing }
        // Exact API fixtures from the disposable seeded backend: B7 and C24,
        // including the original anchor±10 flags and a real missing chain row.
        backend.threadPages["open"] = page
        let directory = FileManager.default.temporaryDirectory.appending(path: "rcf-handoff-\(UUID().uuidString)")
        let workspace = Workspace(backend: backend, instanceName: "Test", host: "test", accountLabel: "test", drafts: DraftStore(root: directory.appending(path: "Drafts"), instance: "test"))
        defer { workspace.stop(); try? FileManager.default.removeItem(at: directory) }
        await workspace.openConcierge()
        await workspace.concierge.reload()
        while workspace.concierge.hasOlder { await workspace.concierge.loadOlder() }
        let store = workspace.concierge
        store.focusPosition.reduceMotion = { reduced }
        let model = AppModel()
        let host = UIHostingController(rootView: ChatScreen(workspace: workspace, shell: ShellActions()).environment(model))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil; window.windowScene = nil }
        try await Task.sleep(for: .milliseconds(450))
        let mainList = try #require(list(host.view, "transcript"))
        let input = try #require(descendants(host.view).compactMap { $0 as? PastingTextView }.first)
        input.text = "Unsent thread draft"
        input.delegate?.textViewDidChange?(input)
        try await Task.sleep(for: .milliseconds(100))
        let inputFrame = input.convert(input.bounds, to: nil)
        let row = try #require(store.rows.first { $0.ownMessageId == target })
        store.jump(to: target)
        try await Task.sleep(for: .milliseconds(450))
        // Allow the same top/middle/bottom positions as a real reader's scroll.
        mainList.contentInset.top = 1000
        mainList.contentInset.bottom = 1000
        let beforeY = try bubbleY(mainList, store: store, row: row.id)
        mainList.contentOffset.y += beforeY - y
        mainList.layoutIfNeeded()
        // A quote tap stops a pending reveal correction or glide before
        // taking its pointer anchor, as the actual quote action does.
        store.focusPosition.pause()
        let pressedY = try bubbleY(mainList, store: store, row: row.id)
        let originalOffset = mainList.contentOffset
        var release: CheckedContinuation<Void, Never>?
        backend.duringThreadFetch = { await withCheckedContinuation { release = $0 } }
        let opening = Task { await store.openThread(from: target, row: row.id, original: root) }
        var samples = 0
        var movingRows = Set<String>()
        var directions: [String: Set<Int>] = [:]
        var sawPictures = false
        func sample(_ phase: String) throws {
            let focusList = list(host.view, "reply-chain-transcript")
            let surface = store.focusPosition.surface
            let pictures = surface?.subviews ?? []
            let visiblePictures = pictures.filter { ($0.layer.presentation()?.opacity ?? Float($0.alpha)) > 0.01 }
            #expect(mainList.alpha > 0 || (focusList?.alpha ?? 0) > 0 || !visiblePictures.isEmpty, "No blank handoff frame: \(phase)")
            for picture in pictures {
                if let shown = picture.layer.presentation(), abs(shown.frame.minY - picture.frame.minY) > 0.5 {
                    movingRows.insert(picture.accessibilityIdentifier ?? "")
                    directions[phase, default: []].insert(picture.frame.minY > shown.frame.minY ? 1 : -1)
                }
                if let id = picture.accessibilityIdentifier?.split(separator: ":").first.map(String.init),
                   allIDs.contains(id), !chainIDs.contains(id) {
                    #expect(abs((picture.layer.presentation()?.frame ?? picture.frame).minY - picture.frame.minY) < 0.5, "Unmatched rows fade at their own position")
                }
                if picture.accessibilityIdentifier == "\(row.id)/0" {
                    let frame = picture.layer.presentation()?.frame ?? picture.frame
                    let actual = surface!.convert(frame, to: nil).minY
                    #expect(abs(actual - pressedY) < 1, "Pinned picture \(phase): \(actual) vs \(pressedY)")
                }
            }
            if !pictures.isEmpty { sawPictures = true }
            if width == 390 && y == 440 && count == 25 && samples.isMultiple(of: 4) {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
                }
                if let data = image.pngData() { Attachment.record(data, named: "thread-\(phase)-\(samples).png") }
            }
            samples += 1
        }
        for _ in 0..<22 {
            await Task.yield()
            try sample("open")
            try await Task.sleep(for: .milliseconds(16))
        }
        let focus = try #require(store.threadFocus)
        let focused = try #require(list(host.view, "reply-chain-transcript"))
        #expect(focus.initial == .loading && focused.alpha == 1)
        let surface = try #require(store.focusPosition.surface)
        let surfaceRect = surface.convert(surface.bounds, to: nil)
        let listRect = focused.convert(focused.bounds, to: nil)
        #expect(abs(surfaceRect.minY - listRect.minY) < 0.001 && abs(surfaceRect.maxY - listRect.maxY) < 0.001 && abs(surfaceRect.width - listRect.width) < 0.001, "Snapshot clipping matches only the transcript viewport")
        #expect(backend.threadReads.count == 1 && focus.transcript.message(missing) == nil)
        let focusedY = try bubbleY(focused, store: focus.transcript, row: row.id)
        #expect(abs(focusedY - pressedY) < 1, "Focused \(focusedY), pressed \(pressedY), wanted \(String(describing: focus.bubbleY))")
        #expect(!store.showsQuoteBar && store.quote == nil)
        #expect(input.text == "Unsent thread draft")
        #expect(input.placeholder == String(localized: "Message in thread"))
        #expect(descendants(host.view).compactMap { $0 as? PastingTextView }.first === input)
        #expect(input.convert(input.bounds, to: nil) == inputFrame)
        #expect(mainList.contentOffset == originalOffset)
        // A short chain hydrates at its entry pin. On the long chain the
        // reader scrolls first, so the current reading row, not the old pin, wins.
        var readingRow = row.id
        if count == 25 {
            focused.delegate?.scrollViewWillBeginDragging?(focused)
            focused.contentOffset.y -= 40
            focused.delegate?.scrollViewDidEndDragging?(focused, willDecelerate: false)
            let top = focused.contentOffset.y + focused.verticalScrollIndicatorInsets.top
            let visible = focused.visibleCells.sorted { $0.frame.minY < $1.frame.minY }
            let readingCell = visible.first { $0.frame.maxY > top }
            readingRow = try #require(readingCell?.accessibilityIdentifier)
        }
        let readingY = try bubbleY(focused, store: focus.transcript, row: readingRow)
        release?.resume()
        await opening.value
        try await Task.sleep(for: .milliseconds(150))
        #expect(focus.initial == nil && focus.transcript.message(missing) != nil)
        let hydratedY = try bubbleY(focused, store: focus.transcript, row: readingRow)
        #expect(abs(hydratedY - readingY) < 1, "Hydration preserves CURRENT reading row \(readingRow): \(readingY) → \(hydratedY)")
        #expect(store.focusPosition.surface?.subviews.isEmpty == true, "Hydration starts no second animation")
        // Return to the entry reading position before testing the inverse pin.
        focused.delegate?.scrollViewWillBeginDragging?(focused)
        focused.contentOffset.y += try bubbleY(focused, store: focus.transcript, row: row.id) - pressedY
        focused.delegate?.scrollViewDidEndDragging?(focused, willDecelerate: false)
        store.closeThread()
        for _ in 0..<22 {
            try sample("close")
            try await Task.sleep(for: .milliseconds(16))
        }
        #expect(store.threadFocus == nil && mainList.alpha == 1)
        #expect(mainList.contentOffset == originalOffset)
        #expect(abs(try bubbleY(mainList, store: store, row: row.id) - pressedY) < 1)
        #expect(input.text == "Unsent thread draft")
        #expect(input.placeholder == String(localized: "Message"))
        #expect(input.convert(input.bounds, to: nil) == inputFrame)
        #expect(descendants(host.view).compactMap { $0 as? PastingTextView }.first === input)
        #expect(sawPictures, "An atomic list-local handoff must actually run")
        if reduced {
            #expect(movingRows.isEmpty, "Reduce Motion changes opacity, not message geometry")
        } else if !UIAccessibility.isReduceMotionEnabled {
            if y == 440 && count == 25 {
                #expect(!movingRows.isEmpty, "Visible matching bubbles actually move toward their own frames")
                let inverse = directions["open"].map { Set($0.map { -$0 }) }
                #expect(directions["close"] == inverse, "Exit reverses the matched geometry, not a common upward fade")
            }
        }
    }
}

/// Read-only native proof against the disposable seeded stack. Unlike the
/// XCTest UI driver, a hosted view can sample the250ms animation without an
/// animation-idle wait outlasting the HTTP client's timeout.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["ROME_RCF_ORIGIN"] != nil))
struct SeededThreadFocusHTTPTests {
    @Test func nativeMemoryRendersWhileRealHTTPIsHeldAndHydratesWithoutAnotherHandoff() async throws {
        let env = ProcessInfo.processInfo.environment
        let origin = try #require(env["ROME_RCF_ORIGIN"].flatMap(URL.init(string:)))
        #expect(origin.host() == "127.0.0.1" || origin.host()?.hasSuffix("localhost") == true)
        var request = URLRequest(url: origin.appending(path: "api/auth/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["userId": try #require(env["ROME_RCF_USER"]), "password": try #require(env["ROME_RCF_PASSWORD"])])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let (_, response) = try await URLSession(configuration: configuration).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        let cookie = try #require((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Set-Cookie"))
        let token = try #require(cookie.components(separatedBy: ";").first?.components(separatedBy: "rome_session=").last)
        let backend = LiveBackend(client: APIClient(origin: origin, token: { token }))
        let directory = FileManager.default.temporaryDirectory.appending(path: "rcf-http-\(UUID().uuidString)")
        let workspace = Workspace(backend: backend, instanceName: "Seeded test", host: "rcf-http", accountLabel: "dev", drafts: DraftStore(root: directory.appending(path: "Drafts"), instance: "rcf-http"))
        defer { workspace.stop(); try? FileManager.default.removeItem(at: directory) }
        await workspace.openConcierge()
        await workspace.concierge.reload()
        let store = workspace.concierge
        let target = "5eedc4a1-0000-4000-8000-000000000047"
        let row = try #require(store.rows.first { $0.ownMessageId == target })
        let host = UIHostingController(rootView: ChatScreen(workspace: workspace, shell: ShellActions()).environment(AppModel()))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; window.windowScene = nil }
        func views(_ root: UIView) -> [UIView] { [root] + root.subviews.flatMap(views) }
        func focusedList() -> UICollectionView? { views(host.view).first { $0.accessibilityIdentifier == "reply-chain-transcript" } as? UICollectionView }
        func y(_ list: UICollectionView, transcript: TranscriptStore) throws -> CGFloat {
            let cell = try #require(list.visibleCells.first { $0.accessibilityIdentifier == row.id })
            let at = try #require(transcript.rows.firstIndex { $0.id == row.id })
            return cell.convert(cell.bounds, to: nil).minY + TranscriptSpacing.top(transcript.rows[at], after: at > 0 ? transcript.rows[at - 1] : nil)
        }
        func capture(_ name: String) {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
            if let data = image.pngData() { Attachment.record(data, named: "http-\(name).png") }
        }
        try await Task.sleep(for: .milliseconds(600))
        store.jump(to: target)
        try await Task.sleep(for: .milliseconds(500))
        let main = try #require(store.focusPosition.main)
        let before = try y(main, transcript: store)
        let offset = main.contentOffset
        capture("before")
        let original = try #require(store.info(for: row).quote?.messageId)
        let opening = Task { await store.openThread(from: target, row: row.id, original: original) }
        for index in 0..<24 {
            try await Task.sleep(for: .milliseconds(16))
            if index.isMultiple(of: 3) { capture("open-\(index)") }
        }
        let focus = try #require(store.threadFocus)
        let list = try #require(focusedList())
        #expect(focus.initial == .loading, "The3s held HTTP response has not arrived")
        let memoryY = try y(list, transcript: focus.transcript)
        #expect(list.alpha == 1 && abs(memoryY - before) < 1)
        #expect(!store.showsQuoteBar)
        capture("memory-held")
        await opening.value
        #expect(focus.initial == nil, "The actual HTTP response must succeed, not time out")
        try await Task.sleep(for: .milliseconds(150))
        #expect(abs(try y(list, transcript: focus.transcript) - before) < 1)
        #expect(store.focusPosition.surface?.subviews.isEmpty == true)
        capture("hydrated")
        store.closeThread()
        for index in 0..<24 {
            try await Task.sleep(for: .milliseconds(16))
            if index.isMultiple(of: 3) { capture("close-\(index)") }
        }
        #expect(store.threadFocus == nil && main.alpha == 1 && main.contentOffset == offset)
        #expect(abs(try y(main, transcript: store) - before) < 1)
        capture("closed")
        print("RCF real held HTTP native anchor=\(before), successful hydration and inverse, no sends")
    }
}
