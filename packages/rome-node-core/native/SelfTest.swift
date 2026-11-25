#if SELF_TEST_BUILD
import AppKit
import CoreGraphics
import CoreMedia
import CryptoKit
import Darwin
import Darwin.libproc
import Darwin.sys.proc_info
import Foundation
import Security

final class SelfTest {
    private var assertions = 0
    private static let verifiedRemoteSigning = TrustedRemoteOverlay.SigningIdentity(
        teamID: "PU9BNSBJW7", identifier: "com.netease.uuremote.server", flags: SecCodeSignatureFlags.runtime.rawValue
    )

    static func run() throws {
        let test = SelfTest()
        try test.identity()
        try test.windows()
        try test.windowFocus()
        try test.bindings()
        try test.input()
        try test.consent()
        try test.activationPolicy()
        try test.authorizationOptions()
        try test.trustedKeyStorage()
        try test.frames()
        try test.admission()
        try test.transport()
        print("{\"ok\":true,\"assertions\":\(test.assertions)}")
    }

    private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try condition() else { throw Failure("self-test: \(message)") }
        assertions += 1
    }

    private func rejects(_ code: String, _ body: () throws -> Void) throws {
        do { try body() }
        catch let failure as Failure {
            try expect(failure.code == code, "expected \(code), received \(failure.code)")
            return
        }
        throw Failure("self-test: expected \(code)")
    }

    private func identity() throws {
        let me = try ProcessIdentity.read(getpid())
        try expect(me.pid == getpid() && me.uid == getuid(), "kernel pid and uid")
        try expect(me.executable.hasPrefix("/") && me.seconds > 0 && me.microseconds < 1_000_000, "kernel path and birth time")
        try me.verify()
        try rejects("process_identity_unavailable") { _ = try ProcessIdentity.read(-1) }
        try rejects("process_identity_unavailable") { _ = try ProcessIdentity.read(Int32.max) }
        for fake in [
            ProcessIdentity(pid: me.pid, uid: me.uid, seconds: me.seconds + 1,
                            microseconds: me.microseconds, executable: me.executable, generation: me.generation),
            ProcessIdentity(pid: me.pid, uid: me.uid, seconds: me.seconds,
                            microseconds: me.microseconds + 1, executable: me.executable, generation: me.generation),
            ProcessIdentity(pid: me.pid, uid: me.uid + 1, seconds: me.seconds,
                            microseconds: me.microseconds, executable: me.executable, generation: me.generation),
            ProcessIdentity(pid: me.pid, uid: me.uid, seconds: me.seconds,
                            microseconds: me.microseconds, executable: "/unknown", generation: me.generation),
        ] {
            try rejects("process_identity_changed") { try fake.verify() }
        }
    }

    private func windows() throws {
        let first = WindowRow(id: 1, pid: 42, bounds: CGRect(x: 120, y: 80, width: 400, height: 300))
        let metadata = Windows.metadata(first, appName: "App", bundleId: "com.example.app", bundleName: "App", title: "Window")
        let frame = try Wire.frame(metadata)
        let record = try JSONSerialization.jsonObject(with: frame.dropFirst(8)) as? [String: Any]
        try expect(record?["bounds"] as? [Double] == [120.0, 80.0, 400.0, 300.0], "wire bounds use the origin and size")

        let second = WindowRow(id: 2, pid: 42, bounds: first.bounds.offsetBy(dx: 300, dy: 0))
        let ghost = WindowRow(id: 3, pid: 42, bounds: first.bounds.offsetBy(dx: 700, dy: 0))
        let differentPID = WindowRow(id: 4, pid: 43, bounds: first.bounds)
        let roots = [WindowRoot(bounds: first.bounds), WindowRoot(bounds: second.bounds)]
        let rows = [first, second, ghost, differentPID]
        try expect(uniqueRoot(first, rows: rows, roots: roots) == 0, "first same-PID window")
        try expect(uniqueRoot(second, rows: rows, roots: roots) == 1, "second same-PID window")
        try expect(uniqueRoot(ghost, rows: rows, roots: roots) == nil, "ghost has no AX root")
        let coincidentRoots = [WindowRoot(bounds: first.bounds), WindowRoot(bounds: first.bounds)]
        try expect(uniqueRoot(first, rows: rows, roots: coincidentRoots) == nil, "ambiguous AX roots")
        try expect(uniqueRoot(first, rows: rows + [WindowRow(id: 5, pid: 42, bounds: first.bounds)], roots: roots) == nil,
                   "ambiguous CG rows")
        let offscreen = WindowRow(id: 5, pid: 42, bounds: first.bounds, visible: false)
        try expect(uniqueRoot(first, rows: rows + [offscreen], roots: roots) == 0, "offscreen CG rows cannot make a match ambiguous")
        try expect(uniqueRoot(offscreen, rows: [offscreen], roots: roots) == nil, "offscreen window is ineligible")
        try expect(uniqueRoot(first, rows: [second], roots: roots) == nil, "closed CG window fails revalidation")
        try expect(uniqueRoot(first, rows: rows, roots: [roots[1]]) == nil, "closed AX root is unavailable")
        let popup = WindowRow(id: 6, pid: first.pid, bounds: first.bounds)
        let stack = [popup, offscreen, differentPID, first]
        try expect(uniqueRoot(popup, rows: stack, roots: coincidentRoots, focused: 1) == 1,
                   "frontmost coincident CG window pairs with the focused AX root")
        try expect(uniqueRoot(first, rows: stack, roots: coincidentRoots, focused: 1) == 0,
                   "the remaining coincident CG window pairs with the remaining AX root")
        try expect(uniqueRoot(first, rows: stack, roots: coincidentRoots) == nil,
                   "coincident CG and AX windows need evidence beyond array order")
        try expect(uniqueRoot(popup, rows: stack, roots: roots, focused: 0) == nil,
                   "focus cannot pair coincident windows if CG and AX counts disagree")
        try expect(uniqueRoot(first, rows: stack, roots: roots, pinned: [first.id: 0]) == 0,
                   "a bound window stays discoverable when a coincident CG window has no AX root")
        try expect(uniqueRoot(popup, rows: stack, roots: roots, pinned: [first.id: 0], focused: 0) == nil,
                   "an unpaired popup cannot take the existing window's root")
        try expect(uniqueRoot(popup, rows: stack, roots: coincidentRoots, pinned: [first.id: 0]) == 1,
                   "a pinned match resolves its peer even when the application is in the background")
        var named = first
        named.title = "Document"
        let namedRoots = [WindowRoot(bounds: first.bounds, title: "Document"), coincidentRoots[1]]
        try expect(uniqueRoot(named, rows: [popup, named], roots: namedRoots) == 0, "unique titles pair coincident windows")
        try expect(uniqueRoot(popup, rows: [popup, named], roots: namedRoots) == 1, "a unique title resolves the unnamed peer")
        try expect(uniqueRoot(popup, rows: [popup, named], roots: [namedRoots[0], namedRoots[0]]) == nil,
                   "duplicate AX titles do not identify a window")
        var namedPeer = popup
        namedPeer.title = "Another document"
        let chromeRoots = [WindowRoot(bounds: first.bounds, title: "Another document - Google Chrome"),
                           WindowRoot(bounds: first.bounds, title: "Document - Google Chrome - Test profile")]
        let coincidentChrome = [named, namedPeer]
        try expect(uniqueRoot(named, rows: coincidentChrome, roots: chromeRoots, chromeTitles: true) == 1,
                   "Chrome pairs an AX title with its profile suffix independently of window order")
        try expect(uniqueRoot(namedPeer, rows: coincidentChrome, roots: chromeRoots, chromeTitles: true) == 0,
                   "Chrome pairs a titled window without a profile suffix")
        try expect(uniqueRoot(named, rows: coincidentChrome, roots: chromeRoots) == nil,
                   "Chrome title decorations are not interpreted in other applications")
        let incompleteChrome = [WindowRoot(bounds: first.bounds, title: "Unrelated"), chromeRoots[1]]
        try expect(uniqueRoot(named, rows: coincidentChrome, roots: incompleteChrome, chromeTitles: true) == nil,
                   "a partial decorated title match cannot select a window")
        namedPeer.title = "Document - Google Chrome - Test profile"
        let ambiguousChrome = [WindowRoot(bounds: first.bounds, title: "Document - Google Chrome"),
                               WindowRoot(bounds: first.bounds, title: namedPeer.title)]
        try expect(uniqueRoot(namedPeer, rows: [named, namedPeer], roots: ambiguousChrome, chromeTitles: true) == nil,
                   "an exact title cannot take a Chrome root with a conflicting decorated match")
        try expect(pinnedWindow(first, rows: stack, rootBounds: first.bounds)?.id == first.id,
                   "an existing binding survives a coincident popup")
        try expect(pinnedWindow(first, rows: [popup], rootBounds: first.bounds) == nil, "closing the original CG window revokes it")
        try expect(pinnedWindow(first, rows: [first], rootBounds: second.bounds) == nil, "divergent AX geometry revokes the binding")
        try expect(pinnedWindow(first, rows: [first, first], rootBounds: first.bounds) == nil, "duplicate CG IDs revoke the binding")
        try expect(pinnedWindow(first, rows: [WindowRow(id: first.id, pid: differentPID.pid, bounds: first.bounds)],
                                rootBounds: first.bounds) == nil, "CG owner changes revoke the binding")
        try expect(pinnedWindow(first, rows: [WindowRow(id: first.id, pid: first.pid, bounds: first.bounds, visible: false)],
                                rootBounds: first.bounds) == nil, "offscreen CG windows revoke the binding")
        let refs = ["subtree": 1]
        try expect(try observedElement("subtree", in: refs, expires: 15, at: 14, belongs: { $0 == 1 }) == 1, "an observation can use a current subtree")
        try rejects("element_unavailable") { _ = try observedElement("subtree", in: refs, expires: 15, at: 15, belongs: { _ in true }) }
        try rejects("element_unavailable") { _ = try observedElement("another binding", in: refs, expires: 15, at: 14, belongs: { _ in true }) }
        let currentOwner = [1: "other-window"]
        try rejects("element_unavailable") {
            _ = try observedElement("subtree", in: refs, expires: 15, at: 14) { currentOwner[$0] == "bound-window" }
        }
        let longText = String(repeating: "中文Rome\n\t🚀", count: 40)
        let preview = observedTextValue(longText, expanded: false)
        try expect(preview.truncated && preview.value.unicodeScalars.count == 160, "the observation marks a shortened text preview")
        let expanded = observedTextValue(longText, expanded: true)
        try expect(!expanded.truncated && expanded.value.utf8.elementsEqual(longText.utf8),
                   "a scoped observation preserves long text and Unicode code units")
        let leading = String(repeating: "a", count: 16_383)
        let bounded = observedTextValue(leading + "🚀end", expanded: true)
        try expect(bounded.truncated && bounded.value == leading, "the byte cap stops at a scalar boundary")
        let maximum = observedTextValue(leading + "a", expanded: true)
        try expect(!maximum.truncated && maximum.value.utf8.count == 16_384, "the exact byte limit is not truncated")
        try rejects("accessibility_permission_required") {
            try DesktopAccess.require(trusted: false, console: true)
        }
        try rejects("console_unavailable") { try DesktopAccess.require(trusted: true, console: false) }
        let layer = kCGWindowLayer as String
        let pid = kCGWindowOwnerPID as String
        let saver = CGWindowLevelForKey(.screenSaverWindow)
        let cursor = [layer: CGWindowLevelForKey(.cursorWindow), pid: 12,
                      kCGWindowOwnerName as String: "Window Server"] as [String: Any]
        let paths: [pid_t: String] = [
            13: "/Applications/Overlay.app/Contents/MacOS/Overlay",
            14: "/System/Library/CoreServices/ScreenSaverEngine.app/Contents/MacOS/ScreenSaverEngine",
            15: "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
            16: "/usr/libexec/PrivacySurface",
        ]
        func available(_ rows: [[String: Any]], trust: ([String: Any]) -> Bool = { _ in false }) -> Bool {
            DesktopAccess.visibleLayersClear(rows, isWindowServer: { $0 == 12 }, executablePath: { paths[$0] }, trustedOverlay: trust)
        }
        try expect(available([[layer: 0], cursor]), "authenticated system cursor leaves the console available")
        var impostor = cursor
        impostor[pid] = 13
        try expect(!available([impostor]), "a third-party window at the cursor level requires an authenticated overlay")
        try expect(available([[layer: saver + 100, pid: 13]]), "an ordinary high overlay leaves the console available")
        try expect(!available([[layer: saver, pid: 14]]), "the screen saver makes the console unavailable")
        try expect(!available([[layer: saver, pid: 15]]), "the system login window makes the console unavailable")
        try expect(!available([[layer: saver, pid: 16]]), "a protected system executable can own a private surface")
        try expect(!available([[layer: saver, pid: 17]]), "an unverifiable high-layer owner fails closed")
        try expect(!available([[layer: CGShieldingWindowLevel(), pid: 13]]), "an untrusted shield level window blocks the console")
        let maximumLayer = CGWindowLevelForKey(.maximumWindow)
        let sharing = kCGWindowSharingState as String
        let privateOverlay = [layer: maximumLayer, pid: 13, sharing: 0]
        let publicOverlay = [layer: maximumLayer, pid: 13, sharing: 1]
        func allowOverlay(_ row: [String: Any]) -> Bool {
            TrustedRemoteOverlay.matches(row) { $0 == 13 ? Self.verifiedRemoteSigning : nil }
        }
        try expect(available([privateOverlay], trust: allowOverlay),
                   "a verified private remote overlay at the maximum level leaves the console available")
        try expect(!available([privateOverlay]), "an unverified private maximum-layer overlay blocks the console")
        try expect(!available([publicOverlay], trust: allowOverlay) &&
                   !available([[layer: maximumLayer, pid: 13]], trust: allowOverlay),
                   "the allowlist requires explicit disabled window sharing")
        try expect(!TrustedRemoteOverlay.matches([layer: saver - 1, pid: 13, sharing: 0]) { _ in Self.verifiedRemoteSigning },
                   "the allowlist excludes ordinary UI from the verified process")
        for signing in [
            TrustedRemoteOverlay.SigningIdentity(teamID: "EXAMPLE123", identifier: Self.verifiedRemoteSigning.identifier,
                                                flags: Self.verifiedRemoteSigning.flags),
            TrustedRemoteOverlay.SigningIdentity(teamID: Self.verifiedRemoteSigning.teamID, identifier: "com.example.remote",
                                                flags: Self.verifiedRemoteSigning.flags),
            TrustedRemoteOverlay.SigningIdentity(teamID: Self.verifiedRemoteSigning.teamID,
                                                identifier: Self.verifiedRemoteSigning.identifier, flags: 0),
        ] {
            try expect(!available([privateOverlay]) { row in TrustedRemoteOverlay.matches(row) { _ in signing } },
                       "a mismatched team, signing ID or runtime flag cannot exempt a shield-level window")
        }
        try expect(!available([[layer: maximumLayer, pid: 15]]) && !available([[layer: maximumLayer, pid: 17]]),
                   "system shields and unverifiable owners still lock the console at the maximum level")
        try expect(!DesktopAccess.visibleLayersClear(nil), "missing window list fails closed")
        let access = DesktopAccess()
        try access.recording(granted: false, required: false)
        try rejects("screen_recording_permission_required") { try access.recording(granted: false, required: true) }
        try access.recording(granted: true, required: true)
        try rejects("screen_recording_permission_required") { try access.recording(granted: false, required: false) }
    }

    private func windowFocus() throws {
        var requests: [String] = []
        func focus(activationPoll: Int?, fallbackPoll: Int? = nil, raisesToFocus: Int = 1,
                   timeout: DispatchTimeInterval = .milliseconds(750)) throws {
            requests.removeAll()
            var poll = 0
            var frontmostAt: Int?
            var raises = 0
            func frontmost() -> Bool { frontmostAt.map { poll >= $0 } ?? false }
            try Windows.focus(frontmost: frontmost, focused: { frontmost() && raises == raisesToFocus }, activate: {
                requests.append("activate")
                frontmostAt = activationPoll
            }, setFrontmost: {
                requests.append("AXFrontmost")
                frontmostAt = fallbackPoll.map { poll + $0 }
            }, raise: {
                try expect(frontmost(), "raise waits for the app to come to the front")
                requests.append("raise")
                raises += 1
            }, check: { poll += 1 }, timeout: timeout)
        }
        try focus(activationPoll: 3)
        try expect(requests == ["activate", "raise"], "asynchronous activation skips the fallback")
        try focus(activationPoll: nil, fallbackPoll: 2)
        try expect(requests == ["activate", "AXFrontmost", "raise"], "Accessibility activates the app before the window is raised")
        try focus(activationPoll: 3, raisesToFocus: 2)
        try expect(requests == ["activate", "raise", "raise"], "raise retries in the foreground until the window has focus")
        try rejects("window_focus_unavailable") { try focus(activationPoll: nil) }
        try expect(requests == ["activate", "AXFrontmost"], "focus fails without raising a background window")
        try rejects("window_focus_unavailable") { try focus(activationPoll: nil, timeout: .milliseconds(50)) }
        try expect(requests == ["activate"], "the focus deadline bounds the activation wait")
    }

    private final class EndedBindings: @unchecked Sendable {
        private let lock = NSLock()
        private var ids: [String] = []

        func record(_ id: String) { lock.withLock { ids.append(id) } }

        func drain() -> [String] {
            lock.withLock {
                defer { ids.removeAll() }
                return ids
            }
        }
    }

    private final class TestCapture: ControlCapture {
        private let output: ScreenControlCapture.Output
        private(set) var startCount = 0
        private(set) var stopCount = 0
        private(set) var isActive = false
        let starts: Bool

        init(starts: Bool, onEnd: @escaping @Sendable () -> Void) {
            self.starts = starts
            output = ScreenControlCapture.Output(onEnd: onEnd)
        }

        func start(check: () throws -> Void) throws {
            startCount += 1
            try check()
            guard starts else { throw Failure("capture_failed") }
            isActive = output.didStart()
        }

        func whileActive<T>(_ body: () throws -> T) throws -> T {
            guard isActive else { throw Failure("binding_unavailable") }
            return try body()
        }

        func stop() {
            stopCount += 1
            isActive = false
            _ = output.end(notify: false)
        }

        func systemStop() {
            isActive = false
            _ = output.end(notify: true)
        }
    }

    private func bindings() throws {
        let config = try ScreenControlCapture.configuration(rect: CGRect(x: 0, y: 0, width: 1600, height: 1200), pixelScale: 2)
        try expect(CMTimeCompare(config.minimumFrameInterval, CMTime(value: 1, timescale: 1)) == 0, "control stream is one fps")
        try expect(config.width == 640 && config.height == 480 && config.queueDepth == 3, "control stream caps frame size and queue")
        try expect(!config.showsCursor && !config.capturesAudio && config.ignoreShadowsSingleWindow, "control stream settings")
        if #available(macOS 14.2, *) { try expect(!config.includeChildWindows, "control excludes child windows") }
        if #available(macOS 15.0, *) { try expect(!config.captureMicrophone, "control excludes microphone audio") }
        try rejects("capture_limit") {
            _ = try ScreenControlCapture.configuration(rect: .zero, pixelScale: 2)
        }

        let ended = EndedBindings()
        let early = ScreenControlCapture.Output { ended.record("early") }
        try expect(!early.end(notify: true) && early.hasEnded, "stream can end before start completes")
        try expect(!early.didStart() && early.latestFrame == nil, "late start cannot restore an ended stream")
        _ = early.end(notify: true)
        try rejects("binding_unavailable") { try early.whileActive { throw Failure("unexpected dispatch") } }
        try expect(ended.drain() == ["early"], "a stream notifies revocation once")

        var registry = WindowBindings<Int>()
        var captures: [TestCapture] = []
        func bind(_ window: CGWindowID, starts: Bool = true, check: () throws -> Void = {}) throws -> String {
            try registry.bind(window: window, context: Int(window), makeCapture: { onEnd in
                let capture = TestCapture(starts: starts, onEnd: onEnd)
                captures.append(capture)
                return capture
            }, onEnd: { ended.record($0) }, check: check)
        }

        try expect(registry.count == 0, "zero bindings")
        try rejects("screen_recording_permission_required") {
            _ = try bind(1) { throw Failure("screen_recording_permission_required") }
        }
        try expect(captures.isEmpty, "permission check precedes capture creation")
        try rejects("capture_failed") { _ = try bind(1, starts: false) }
        try expect(captures[0].startCount == 1 && captures[0].stopCount == 1 && registry.count == 0, "failed start releases stream and ownership")

        let first = try bind(1)
        try expect(UUID(uuidString: first) != nil && registry.count == 1, "one binding is active")
        try rejects("window_already_bound") { _ = try bind(1) }
        try expect(captures.count == 2 && captures[1].isActive, "duplicate bind leaves original stream running")
        let second = try bind(2)
        try expect(first != second && registry.count == 2, "distinct bindings coexist")
        var firstBinding = try registry.current(first)
        firstBinding.context = 10
        registry.update(firstBinding)
        try expect(try registry.current(first).context == 10 && registry.current(second).context == 2, "bindings own independent state")
        try registry.unbind(first)
        try expect(captures[1].stopCount == 1 && captures[2].isActive && registry.count == 1, "unbind stops only the named stream")
        try rejects("binding_not_found") { try registry.unbind(first) }
        try expect(ended.drain().isEmpty, "intentional stop does not signal system revocation")

        let rebound = try bind(1)
        try expect(rebound != first, "released window receives a fresh binding")
        captures[2].systemStop()
        captures[2].systemStop()
        try rejects("binding_unavailable") { _ = try registry.current(second) }
        let revoked = ended.drain()
        try expect(revoked == [second], "system stop posts revocation for only its binding")
        revoked.forEach { registry.remove($0) }
        try expect(try registry.current(rebound).capture.isActive, "system stop leaves other streams active")
        let other = try bind(2)
        captures[4].systemStop()
        for id in ended.drain() { registry.remove(id) }
        try rejects("binding_not_found") { try registry.unbind(other) }
        try expect(registry.count == 1, "callback removes binding without an RPC")

        _ = try bind(2)
        registry.stopAll()
        try expect(registry.count == 0, "stop clears all binding state")
        try expect(captures[3].stopCount == 1 && captures[5].stopCount == 1, "stop ends every active stream once")
        try rejects("binding_unavailable") { _ = try registry.current(rebound) }
        let fresh = try bind(1)
        registry.remove(rebound)
        let active = try registry.current(fresh).capture
        try expect(active.isActive, "stale callback cannot revoke a newer binding")
        try registry.requireAvailable(1, stillMatches: { $0 == 2 })
        try rejects("binding_unavailable") { _ = try registry.current(fresh) }
        try expect(!active.isActive, "a replacement AX root releases an active capture")
        let replacement = try bind(1)
        try expect(replacement != fresh && (try registry.current(replacement).capture.isActive),
                   "a reused CG window ID can bind without an action on the stale binding")
        registry.stopAll()
    }

    private func input() throws {
        let bounds = CGRect(x: -200, y: 50, width: 120, height: 100)
        let point = CGPoint(x: -190, y: 70)
        try expect(try WindowInput.global(CGPoint(x: 10, y: 20), in: bounds) == point, "negative monitor origin uses logical points")
        for outside in [CGPoint(x: -1, y: 0), CGPoint(x: 120, y: 2), CGPoint(x: 2, y: 100),
                        CGPoint(x: CGFloat.nan, y: 0), CGPoint(x: 0, y: CGFloat.infinity)] {
            try rejects("window_coordinate_out_of_bounds") { _ = try WindowInput.global(outside, in: bounds) }
        }

        let pid: pid_t = getpid() == 42 ? 43 : 42
        let target = WindowRow(id: 7, pid: pid, bounds: bounds)
        func row(_ id: CGWindowID, _ pid: pid_t, _ bounds: CGRect, layer: Int32 = 0,
                 owner: String = "Other App", alpha: Double = 1) -> [String: Any] {
            [kCGWindowNumber as String: id, kCGWindowOwnerPID as String: pid,
             kCGWindowLayer as String: layer, kCGWindowBounds as String: bounds.dictionaryRepresentation,
             kCGWindowOwnerName as String: owner, kCGWindowAlpha as String: alpha]
        }
        let expected = row(target.id, pid, bounds)
        let helper = row(8, getpid(), bounds)
        let adjacent = row(9, pid, CGRect(x: -140, y: 50, width: 50, height: 100))
        let cursor = row(10, 99, bounds, layer: CGWindowLevelForKey(.cursorWindow), owner: "Window Server")
        let document = row(11, pid, bounds)
        let popup = row(12, pid, bounds, layer: 1)
        let foreignPopup = row(13, getpid(), bounds, layer: 1)
        let highLayer = CGWindowLevelForKey(.screenSaverWindow) + 100
        let highOverlay = row(14, 97, bounds, layer: highLayer)
        let highOverlayAway = row(15, 97, bounds.offsetBy(dx: 400, dy: 0), layer: highLayer)
        var remoteOverlay = row(16, 97, bounds.insetBy(dx: -200, dy: -200), layer: CGWindowLevelForKey(.maximumWindow))
        remoteOverlay[kCGWindowSharingState as String] = 0
        func verify(_ rows: [[String: Any]], at point: CGPoint? = nil, target: WindowRow = target,
                    verified: Bool = true, hit: (CGPoint) -> Bool = { _ in false }) throws {
            try WindowInput.verifyStack(rows, target: target, point: point, isWindowServer: { $0 == 99 },
                                        trustedOverlay: { row in
                TrustedRemoteOverlay.matches(row) { verified && $0 == 97 ? Self.verifiedRemoteSigning : nil }
            }, hitsTarget: hit)
        }
        try verify([cursor, adjacent, expected, helper], at: point)
        try verify([expected, adjacent, helper])
        try rejects("window_coordinate_out_of_bounds") { try verify([expected], at: CGPoint(x: -70, y: 70)) }
        for blocker in [helper, foreignPopup, highOverlay] {
            try rejects("window_occluded") { try verify([blocker, expected], at: point) }
            try rejects("window_occluded") { try verify([blocker, expected]) }
        }
        try expect((try? verify([highOverlayAway, expected], at: point)) != nil,
                   "a high overlay outside the target does not block input")
        try expect((try? verify([remoteOverlay, expected], at: point, hit: { $0 == point })) != nil,
                   "a private full-screen remote overlay allows a pointer hit on the bound window")
        try expect((try? verify([remoteOverlay, expected], hit: { $0 == CGPoint(x: bounds.midX, y: bounds.midY) })) != nil,
                   "keyboard input can use a verified pass-through point in the overlap")
        try rejects("window_occluded") { try verify([remoteOverlay, expected], at: point) }
        try rejects("window_occluded") { try verify([remoteOverlay, expected], at: point, verified: false, hit: { _ in true }) }
        try rejects("window_occluded") { try verify([remoteOverlay, expected], verified: false, hit: { _ in true }) }
        var shareableOverlay = remoteOverlay
        shareableOverlay[kCGWindowSharingState as String] = 1
        try rejects("window_occluded") { try verify([shareableOverlay, expected], at: point, hit: { _ in true }) }
        try rejects("window_occluded") { try verify([row(17, pid, bounds, layer: highLayer), expected], hit: { _ in true }) }
        try rejects("window_occluded") { try verify([remoteOverlay, helper, expected], at: point, hit: { _ in true }) }
        for blocker in [document, popup] {
            try rejects("window_occluded") { try verify([blocker, expected], at: point) }
        }
        try verify([document, popup, expected])
        try rejects("window_unavailable") { try verify([adjacent], at: point) }
        try rejects("window_unavailable") { try verify([expected, expected], at: point) }
        try rejects("window_unavailable") { try verify([row(7, getpid(), bounds)], at: point) }
        try rejects("window_unavailable") { try verify([row(7, pid, bounds, alpha: 0)], at: point) }
        try rejects("window_unavailable") { try verify([row(7, pid, bounds.offsetBy(dx: 2, dy: 0))], at: point) }
        try rejects("window_unavailable") { try verify([helper], at: point, target: WindowRow(id: 8, pid: getpid(), bounds: bounds)) }

        func action(_ name: String, _ args: [String: Any]) throws -> WindowInput {
            var args = args
            args["action"] = name
            let data = try JSONSerialization.data(withJSONObject: ["v": 1, "id": "test", "method": "act", "params": args])
            guard let params = try Wire.request(data).params, let input = try WindowInput(action: name, args: params) else {
                throw Failure("self-test: input request")
            }
            return input
        }

        var events: [CGEvent] = []
        var checks: [CGPoint?] = []
        var releases = 0
        var lookup: (String, CGEventFlags) -> (CGKeyCode, CGEventFlags)? = { _, _ in nil }
        let identity = try ProcessIdentity.read(getpid())
        let staleIdentity = ProcessIdentity(pid: identity.pid, uid: identity.uid, seconds: identity.seconds + 1,
                                            microseconds: identity.microseconds, executable: identity.executable,
                                            generation: identity.generation)
        func run(_ action: WindowInput, limit: Int = .max, releaseIdentity: ProcessIdentity = identity) throws {
            events.removeAll()
            checks.removeAll()
            releases = 0
            try action.execute(window: target, locate: { try WindowInput.global($0, in: bounds) },
                               lookupKey: lookup, send: { point, batch in
                guard checks.count < limit else { throw Failure("session_stopped") }
                checks.append(point)
                events += batch
            }, release: { event in
                releases += 1
                try WindowInput.releaseDrag(event, identity: releaseIdentity) { events.append($0) }
            })
        }
        try run(action("click", ["x": 10, "y": 20, "button": "middle", "clickCount": 3, "modifiers": ["command", "shift"]]))
        try expect(events.map(\.type) == Array(repeating: [.otherMouseDown, .otherMouseUp], count: 3).flatMap { $0 },
                   "middle triple-click has three down/up pairs")
        try expect(events.map { $0.getIntegerValueField(.mouseEventClickState) } == [1, 1, 2, 2, 3, 3], "click counts advance per pair")
        let local = CGPoint(x: 10, y: 20)
        try expect(checks == [point, point, point] && events.allSatisfy {
            $0.location == local && $0.flags.contains([.maskCommand, .maskShift]) &&
                NSEvent(cgEvent: $0)?.windowNumber == Int(target.id)
        }, "click validates global coordinates and carries AppKit window routing with local coordinates")
        let clickNumbers = events.map { $0.getIntegerValueField(.mouseEventNumber) }
        try expect(clickNumbers[0] == clickNumbers[1] && clickNumbers[2] == clickNumbers[3] &&
                   clickNumbers[4] == clickNumbers[5] && Set(clickNumbers).count == 3, "each click has a paired event number")
        try run(action("move", ["x": 10, "y": 20]))
        try expect(events.map(\.type) == [.mouseMoved] && checks == [point], "move validates and posts one event")
        let drag = try action("drag", ["x": 10, "y": 20, "toX": 20, "toY": 40, "steps": 2, "button": "right"])
        try run(drag)
        try expect(events.map(\.type) == [.rightMouseDown, .rightMouseDragged, .rightMouseDragged, .rightMouseUp],
                   "drag emits a down, interpolated steps and an up")
        let midpoint = CGPoint(x: 15, y: 30)
        try expect(checks[2] == CGPoint(x: -185, y: 80) && events[1].location == midpoint &&
                   events[3].location == CGPoint(x: 20, y: 40) && releases == 0,
                   "drag hits midpoint and exact endpoint")
        try rejects("session_stopped") { try run(drag, limit: 3) }
        try expect(events.map(\.type) == [.rightMouseDown, .rightMouseDragged, .rightMouseUp] && releases == 1 &&
                   events.last?.location == midpoint, "interrupted drag releases once at the last point and skips further moves")
        try rejects("session_stopped") { try run(drag, limit: 3, releaseIdentity: staleIdentity) }
        try expect(events.map(\.type) == [.rightMouseDown, .rightMouseDragged] && releases == 1,
                   "a changed process identity blocks the cleanup mouse-up")
        try rejects("session_stopped") { try run(drag, limit: 1) }
        try expect(events.isEmpty && releases == 0, "a rejected mouse-down needs no cleanup")
        try rejects("window_coordinate_out_of_bounds") {
            try run(action("drag", ["x": 10, "y": 20, "toX": 120, "toY": 40]))
        }
        try expect(events.isEmpty && checks.isEmpty, "invalid drag destination fails before sending")
        try run(action("scroll", ["x": 10, "y": 20, "deltaX": -5, "deltaY": 12]))
        try expect(events.count == 1 && events[0].type == .scrollWheel && checks == [point] && events[0].location == local &&
                   NSEvent(cgEvent: events[0])?.windowNumber == Int(target.id) &&
                   events[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis1) == -12 &&
                   events[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis2) == 5, "scroll direction uses pixel units")

        try run(action("key_press", ["key": "f12", "modifiers": ["control", "option"]]))
        try expect(events.map(\.type) == [.keyDown, .keyUp] && checks == [nil] && events.allSatisfy {
            $0.getIntegerValueField(.keyboardEventKeycode) == 111 && $0.flags.contains([.maskControl, .maskAlternate])
        }, "named key emits a pair with modifiers")
        lookup = { name, flags in name == "q" ? (12, flags) : nil }
        try run(action("key_press", ["key": "q", "modifiers": ["command"]]))
        try expect(events.first?.getIntegerValueField(.keyboardEventKeycode) == 12, "character shortcut uses layout key code")
        try rejects("key_unavailable") { try run(action("key_press", ["key": "🪴", "modifiers": ["command"]])) }
        try run(action("key_press", ["key": "🪴"]))
        try expect(events.map(\.type) == [.keyDown, .keyUp], "unmapped unmodified character uses Unicode")
        let text = String(repeating: "a", count: 15) + "🪴" + String(repeating: "b", count: 16)
        let chunks = WindowInput.unicodeChunks(text)
        try expect(chunks.map(\.count) == [15, 16, 2] && chunks.flatMap { $0 } == Array(text.utf16),
                   "Unicode chunks preserve surrogate pairs and order")
        try run(action("type_text", ["text": text]))
        try expect(events.count == chunks.count * 2 && checks == [nil, nil, nil], "each text chunk revalidates once")
        try rejects("session_stopped") { try run(action("type_text", ["text": text]), limit: 1) }
        try expect(events.count == 2, "stopped text never sends later chunks")

        for (name, args): (String, [String: Any]) in [
            ("click", ["x": 1, "y": 2, "clickCount": 4]),
            ("click", ["x": 1, "y": 2, "button": "unknown"]),
            ("drag", ["x": 1, "y": 2, "toX": 3, "toY": 4, "steps": 61]),
            ("scroll", ["x": 1, "y": 2, "deltaX": 2001, "deltaY": 0]),
            ("move", ["x": 1, "y": 2, "modifiers": ["shift", "shift"]]),
            ("key_press", ["key": "unknown"]),
            ("type_text", ["text": ""]),
            ("type_text", ["text": String(repeating: "a", count: 16_385)]),
        ] {
            try rejects("invalid_value") { _ = try action(name, args) }
        }
    }

    private func consent() throws {
        let modeButtons: [(ConsentMode, [HelperLocale.Text])] = [
            (.sessionOnly, [.deny, .allowSession]),
            (.persistentOnly, [.deny, .allowPersistent]),
            (.sessionOrPersistent, [.deny, .allowSession, .allowPersistent]),
        ]
        for (mode, titles) in modeButtons {
            try expect(mode.choices.map(\.buttonTitle) == titles,
                       "\(mode.rawValue) maps each decision to a response button with Deny first")
        }
        let start = DispatchTime(uptimeNanoseconds: 1_000_000_000)
        let deadline = start + .seconds(60)
        try expect(ConsentCountdown.seconds(until: deadline, now: start) == 60, "show the full consent period at presentation")
        try expect(ConsentCountdown.seconds(until: deadline, now: start + .milliseconds(999)) == 60,
                   "a fraction of a second rounds up so zero is never shown before expiration")
        try expect(ConsentCountdown.seconds(until: deadline, now: start + .seconds(1)) == 59,
                   "the countdown changes only across a whole-second boundary")
        try expect(ConsentCountdown.seconds(until: deadline, now: deadline - .milliseconds(1)) == 1,
                   "one remains visible until the actual deadline")
        try expect(ConsentCountdown.seconds(until: deadline, now: deadline) == 0 &&
                   ConsentCountdown.seconds(until: deadline, now: deadline + .seconds(1)) == 0,
                   "consent expires at the server deadline without negative time")
        for (locale, title) in [(HelperLocale.en, "Deny (59s)"), (.zhHans, "拒绝 (59s)"),
                                (.zhHant, "拒絕 (59s)"), (.ja, "拒否 (59s)")] {
            try expect(ConsentCountdown.title(locale, seconds: 59) == title, "localize Deny with the remaining time")
        }

        var poll = ConsentPoll()
        try expect(poll.begin() == nil, "do not sample a modal that has not begun")
        poll.start()
        let stale = try require(poll.begin(), "start an asynchronous visibility sample")
        try expect(poll.begin() == nil, "coalesce timer ticks while WindowServer sampling is in flight")
        poll.invalidate()
        try expect(poll.begin() == nil && !poll.finish(stale), "discard a result after focus or layout changes without queueing more work")
        let current = try require(poll.begin(), "start a fresh visibility sample after invalidation")
        try expect(poll.finish(current), "apply the current sample")
        let closed = try require(poll.begin(), "sample before the modal exits")
        poll.stop()
        poll.start()
        try expect(!poll.finish(closed), "a newly presented modal cannot consume a previous modal's sample")

        var state = ConsentUnlock()
        try expect(state.state(focused: false, raised: true, at: 0) == .needsFocus, "consent prompts for a click when inactive")
        try expect(state.state(focused: true, raised: true, at: 0.05) == .checking, "consent shows its initial focused wait")
        try expect(state.state(focused: true, raised: true, at: 0.5) == .checking, "consent remains waiting before the dwell ends")
        try expect(state.state(focused: true, raised: true, at: 0.55) == .ready, "consent becomes ready after a full focused half-second")
        try expect(state.state(focused: true, raised: false, at: 0.6) == .occluded, "a temporary cover pauses consent")
        try expect(state.state(focused: false, raised: false, at: 0.625) == .occluded,
                   "a covering window can also take focus without ending consent")
        try expect(!state.revalidate(clear: false, focused: false, eligible: true, at: 0.625),
                   "approval is rejected under a covering window")
        try expect(state.state(focused: true, raised: true, at: 0.65) == .checking, "consent waits again after being raised")
        try expect(state.state(focused: true, raised: true, at: 1.145) == .checking, "clearing a cover starts a full half-second of dwell")
        try expect(state.state(focused: true, raised: true, at: 1.155) == .ready, "consent unlocks after the full uncovered dwell")
        try expect(!state.revalidate(clear: false, focused: true, eligible: true, at: 1.16),
                   "a stale enabled button cannot approve under a new overlay")
        try expect(state.state(focused: false, raised: true, at: 1.2) == .needsFocus, "consent prompts again on focus loss")
        let host = Admission()
        _ = host.stop("host_disconnected")
        let hostLive = (try? host.check()) != nil
        try expect(state.state(eligible: hostLive, focused: true, raised: false, at: 1.5) == nil,
                   "host shutdown ends consent even while covered")
        let consoleAvailable = false
        try expect(state.state(eligible: consoleAvailable, focused: true, raised: true, at: 2) == nil,
                   "loss of the console ends consent even with an unobstructed window")
        let prompt = CGRect(x: 140, y: 260, width: 320, height: 220)
        let helper: pid_t = 42
        let server: pid_t = 43
        let other: pid_t = 44
        let cursor = CGWindowLevelForKey(.cursorWindow)
        let layerKey = kCGWindowLayer as String
        func row(_ pid: pid_t, _ bounds: CGRect, layer: Int32 = 0, owner: String = "Other App",
                 alpha: Double = 1) -> [String: Any] {
            [kCGWindowOwnerPID as String: pid, kCGWindowBounds as String: bounds.dictionaryRepresentation,
             layerKey: layer, kCGWindowOwnerName as String: owner, kCGWindowAlpha as String: alpha]
        }
        func clear(_ above: ArraySlice<[String: Any]>?, bounds: CGRect? = prompt, verifiedOverlay: Bool = false) -> Bool {
            ConsentOcclusion.clear(alertBounds: bounds, above: above, helperPID: helper, isWindowServer: { $0 == server },
                                   allowsOverlay: { row in
                TrustedRemoteOverlay.matches(row) { verifiedOverlay && $0 == other ? Self.verifiedRemoteSigning : nil }
            })
        }
        try expect(ConsentOcclusion.alertLevel > Int(CGWindowLevelForKey(.statusWindow)) &&
                   ConsentOcclusion.alertLevel > Int(CGWindowLevelForKey(.popUpMenuWindow)) &&
                   DesktopAccess.visibleLayersClear([[layerKey: ConsentOcclusion.alertLevel]]),
                   "consent is above menus and status windows without blocking the console")
        try expect(!clear([row(other, prompt)]), "overlapping window from another process blocks consent")
        try expect(!clear([row(other, prompt, layer: CGWindowLevelForKey(.screenSaverWindow) + 100)]),
                   "a high third-party overlay blocks consent at overlapping bounds")
        var remoteCover = row(other, prompt.insetBy(dx: -100, dy: -100), layer: CGWindowLevelForKey(.maximumWindow))
        remoteCover[kCGWindowSharingState as String] = 0
        try expect(!clear([remoteCover]) && clear([remoteCover], verifiedOverlay: true),
                   "a private remote overlay at the maximum level requires a verified input path")
        try expect(!clear([remoteCover, row(other, prompt)], verifiedOverlay: true),
                   "a verified remote overlay never overrides an ordinary foreground cover")
        var titleCover = row(other + 1, CGRect(x: prompt.minX, y: prompt.minY + 10, width: prompt.width, height: 20),
                             layer: CGWindowLevelForKey(.maximumWindow))
        titleCover[kCGWindowSharingState as String] = 0
        try expect(!clear([titleCover], verifiedOverlay: true),
                   "an untrusted strip over the title blocks consent even when dialog and button centers remain clear")
        var shareableCover = remoteCover
        shareableCover[kCGWindowSharingState as String] = 1
        try expect(!clear([shareableCover], verifiedOverlay: true),
                   "a signed remote process's shareable window still blocks consent")
        try expect(!clear([row(other, prompt, alpha: 0)]), "transparent click-through window blocks consent")
        try expect(clear([row(other, prompt.offsetBy(dx: 400, dy: 0))]), "nonoverlapping window leaves consent clear")
        try expect(clear([row(other, .zero), row(helper, prompt)]), "empty and helper-owned windows leave consent clear")
        try expect(clear([row(server, prompt, layer: cursor, owner: "Window Server")]), "system cursor leaves consent clear")
        try expect(!clear([row(server, prompt, owner: "Window Server")]), "other Window Server layers block consent")
        try expect(!clear([row(other, prompt, layer: cursor, owner: "Window Server")]), "cursor exemption requires the Window Server PID")
        try expect(!clear(nil) && !clear([], bounds: nil) && !clear([[kCGWindowOwnerPID as String: other]]),
                   "missing window data fails closed")
        let numberKey = kCGWindowNumber as String
        let onScreenKey = kCGWindowIsOnscreen as String
        let realSurface: [[String: Any]] = [[numberKey: 22, onScreenKey: true]]
        try expect(ConsentOcclusion.isHiddenParent(21, surfaces: [21, 22], info: [numberKey: 21], onScreen: realSurface),
                   "the offscreen AppKit backing window does not block checks of its visible child")
        try expect(!ConsentOcclusion.isHiddenParent(21, surfaces: [21], info: nil, onScreen: []),
                   "an offscreen root alone does not qualify for consent")
        try expect(!ConsentOcclusion.isHiddenParent(22, surfaces: [21, 22], info: nil, onScreen: []),
                   "a reported child must always pass visibility checks")
        try expect(!ConsentOcclusion.isHiddenParent(21, surfaces: [21, 22], info: [onScreenKey: true], onScreen: realSurface) &&
                   !ConsentOcclusion.isHiddenParent(21, surfaces: [21, 22], info: nil, onScreen: [[numberKey: 21]]),
                   "a parent reported on screen by either snapshot must be checked")
        let ownerKey = kCGWindowOwnerPID as String
        let backingRow: [String: Any] = [numberKey: 21, ownerKey: helper, layerKey: ConsentOcclusion.alertLevel]
        try expect(ConsentOcclusion.ownsAlertSurface(backingRow, id: 21, pid: helper) &&
                   !ConsentOcclusion.ownsAlertSurface(backingRow, id: 21, pid: other) &&
                   !ConsentOcclusion.ownsAlertSurface(backingRow, id: 23, pid: helper),
                   "a backing window must match both the known AppKit ID and the helper owner")
        try expect(!ConsentOcclusion.ownsAlertSurface([numberKey: 21, ownerKey: helper, layerKey: 0], id: 21, pid: helper),
                   "an alert backing window must remain at the alert level")
        let visibleWithBacking = ConsentVisibility(surfaces: [22], backingWindow: 21, needsHitTest: true)
        try expect(visibleWithBacking.acceptsHit(21, backingIsCurrent: true) &&
                   visibleWithBacking.acceptsHit(22, backingIsCurrent: false),
                   "AppKit mouse hits can land on the verified parent or the rendered child")
        try expect(!visibleWithBacking.acceptsHit(21, backingIsCurrent: false),
                   "the reported backing ID still has to resolve to the current alert in AppKit")
        try expect(!visibleWithBacking.acceptsHit(23, backingIsCurrent: true) &&
                   !visibleWithBacking.acceptsHit(nil, backingIsCurrent: true) &&
                   !ConsentVisibility(surfaces: [], backingWindow: 21, needsHitTest: true).acceptsHit(21, backingIsCurrent: true),
                   "an unrelated surface, missing hit or backing window alone cannot unlock the alert")
        var remote = ConsentUnlock()
        let clearRemoteHit = clear([remoteCover], verifiedOverlay: visibleWithBacking.acceptsHit(21, backingIsCurrent: true))
        try expect(remote.state(focused: true, raised: clearRemoteHit, at: 1) == .checking &&
                   remote.state(focused: true, raised: clearRemoteHit, at: 1.5) == .ready,
                   "a verified backing-window hit under a remote overlay still requires a full dwell")
        remote.mouseDown(at: 1.625, clickCount: 0, enabled: true)
        try expect(remote.revalidate(clear: clearRemoteHit, focused: true, eligible: true, at: 1.625) &&
                   remote.accept(currentClickCount: 0, doubleClickInterval: 0.5),
                   "a zero-count click can approve through the verified backing window")

        var unlock = ConsentUnlock()
        try expect(!unlock.update(focused: true, at: 0), "consent starts locked")
        try expect(!unlock.update(focused: true, at: 0.495), "consent stays locked for the first half-second")
        try expect(unlock.update(focused: true, at: 0.5), "consent unlocks after one focused half-second")
        try expect(!unlock.update(focused: false, at: 0.55), "focus loss relocks consent immediately")
        unlock = ConsentUnlock()
        try expect(!unlock.update(focused: true, at: 0), "a new confirmation starts locked")
        try expect(!unlock.update(focused: false, at: 0.4), "focus loss clears the partial delay")
        try expect(!unlock.update(focused: true, at: 0.5), "regaining focus restarts the delay")
        try expect(!unlock.update(focused: true, at: 0.6), "prior focus time does not count")
        try expect(unlock.update(focused: true, at: 1), "consent unlocks after a full half-second of renewed focus")

        unlock = ConsentUnlock()
        try expect(!unlock.update(focused: true, at: 0), "consent starts locked before repeated clicks")
        for timestamp in stride(from: 0.125, through: 0.625, by: 0.125) {
            let enabled = unlock.update(focused: true, at: timestamp)
            try expect(!enabled, "repeated clicks keep consent locked past one focused half-second")
            unlock.mouseDown(at: timestamp, clickCount: 1, enabled: enabled)
        }
        try expect(!unlock.update(focused: true, at: 0.625), "the last click restarts the delay")
        try expect(!unlock.update(focused: true, at: 1.12), "consent needs a full quiet half-second")
        try expect(unlock.update(focused: true, at: 1.125), "one focused half-second without clicks unlocks consent")

        unlock.mouseDown(at: 1.125, clickCount: 0, enabled: true)
        try expect(unlock.accept(currentClickCount: 0, doubleClickInterval: 0.5),
                   "a remote single click can approve after a full dwell following a disabled focus click")
        try expect(unlock.update(focused: true, at: 1.625), "approval consumes the gesture without changing the dwell")

        unlock.mouseDown(at: 1.625, clickCount: 2, enabled: true)
        try expect(!unlock.accept(currentClickCount: nil, doubleClickInterval: 0.5),
                   "a recorded double-click is rejected even when the current event has changed")
        try expect(!unlock.update(focused: true, at: 1.625), "rejecting a double-click relocks consent")
        try expect(unlock.update(focused: true, at: 2.125), "consent unlocks after a quiet half-second")

        unlock.mouseDown(at: 2.125, clickCount: 1, enabled: true)
        unlock.mouseDown(at: 2.25, clickCount: 1, enabled: true)
        try expect(!unlock.accept(currentClickCount: 1, doubleClickInterval: 0.5),
                   "a single click too close to another unlocked click is rejected")
        try expect(!unlock.update(focused: true, at: 2.25), "the close single click relocks consent")
        try expect(unlock.update(focused: true, at: 2.75), "consent unlocks after the final quiet half-second")
        unlock.mouseDown(at: 2.875, clickCount: 1, enabled: true)
        try expect(unlock.accept(currentClickCount: 1, doubleClickInterval: 0.5),
                   "a single click past the double-click interval approves consent")

        unlock = ConsentUnlock()
        unlock.mouseDown(at: 0, clickCount: 0, enabled: true)
        try expect(!unlock.accept(currentClickCount: 0, doubleClickInterval: 0.5),
                   "invalid clock samples cannot record a gesture")
        unlock.mouseDown(at: 1, clickCount: 0, enabled: true)
        unlock.mouseDown(at: 0.75, clickCount: 0, enabled: true)
        try expect(!unlock.accept(currentClickCount: 0, doubleClickInterval: 0.5),
                   "a backward clock sample clears any pending gesture")
        unlock.mouseDown(at: 1.5, clickCount: 0, enabled: true)
        try expect(!unlock.accept(currentClickCount: 0, doubleClickInterval: 0.5),
                   "a backward sample cannot shorten a prior enabled click interval")
        unlock.mouseDown(at: 2.125, clickCount: 0, enabled: true)
        try expect(!unlock.accept(currentClickCount: 2, doubleClickInterval: 0.5),
                   "an AppKit double-click on release cannot approve a recorded single click")
        unlock.mouseDown(at: 2.75, clickCount: 0, enabled: true)
        try expect(unlock.accept(currentClickCount: nil, doubleClickInterval: 0.5),
                   "a recorded remote single click survives an AppKit change of current event")

        unlock = ConsentUnlock()
        try expect(!unlock.update(focused: true, at: 0), "consent starts locked before typing")
        for timestamp in stride(from: 0.125, through: 0.625, by: 0.125) {
            let enabled = unlock.update(focused: true, at: timestamp)
            try expect(!enabled, "key presses keep consent locked past one focused half-second")
            unlock.keyDown(enabled: enabled)
        }
        try expect(!unlock.update(focused: true, at: 0.625), "the last key press restarts the delay")
        try expect(!unlock.update(focused: true, at: 1.12), "typing requires a full quiet half-second")
        try expect(unlock.update(focused: true, at: 1.125), "one focused half-second without typing unlocks consent")
        unlock.keyDown(enabled: true)
        try expect(unlock.update(focused: true, at: 1.15), "keyboard navigation remains available after unlocking")

        for choice in ConsentMode.sessionOrPersistent.choices.dropFirst() {
            var shared = ConsentUnlock()
            try expect(!shared.update(focused: true, at: 0), "\(choice) starts locked")
            shared.mouseDown(at: 0.495, clickCount: 1, enabled: false)
            try expect(!shared.update(focused: true, at: 0.5), "a locked click restarts both choices")
            try expect(shared.update(focused: true, at: 1), "\(choice) shares the full quiet half-second")
            shared.keyDown(enabled: true, isRepeat: true)
            try expect(!shared.accept(currentClickCount: nil, doubleClickInterval: 0.5), "a held key cannot approve")
            try expect(!shared.update(focused: true, at: 1.125), "a repeat relocks both choices")
            try expect(shared.update(focused: true, at: 1.625), "both choices unlock after a quiet half-second")
            shared.keyDown(enabled: true)
            try expect(shared.accept(currentClickCount: nil, doubleClickInterval: 0.5), "fresh keyboard approval works")
            try expect(shared.revalidate(clear: true, focused: true, eligible: true, at: 1.625), "approval still qualifies")
            shared.mouseDown(at: 1.75, clickCount: 2, enabled: true)
            try expect(!shared.accept(currentClickCount: nil, doubleClickInterval: 0.5), "\(choice) rejects a double-click")
            try expect(!shared.update(focused: true, at: 2) && shared.update(focused: true, at: 2.5),
                       "double-click rejection relocks both choices")
            var uptime = 2.5
            for (clear, focused, eligible) in [(false, true, true), (true, false, true), (true, true, false)] {
                try expect(!shared.revalidate(clear: clear, focused: focused, eligible: eligible, at: uptime),
                           "approval rechecks visibility, focus and eligibility")
                try expect(!shared.update(focused: true, at: uptime), "failed recheck relocks all approval choices")
                uptime += 0.5
                try expect(shared.update(focused: true, at: uptime), "approval can be checked again after refocusing")
            }
        }
    }

    private func activationPolicy() throws {
        var setCalled = false
        try requireAccessoryPolicy(current: { .accessory }, set: { _ in
            setCalled = true
            return false
        })
        try expect(!setCalled, "already accessory passes without a setter call")
        for setResult in [true, false] {
            var current = NSApplication.ActivationPolicy.regular
            var requested: NSApplication.ActivationPolicy?
            try requireAccessoryPolicy(current: { current }, set: {
                requested = $0
                current = $0
                return setResult
            })
            try expect(requested == .accessory && current == .accessory, "the resulting policy determines success")
        }
        try rejects("console_unavailable") {
            try requireAccessoryPolicy(current: { .regular }, set: { _ in false })
        }
    }

    private func authorizationOptions() throws {
        for (tag, locale) in [
            ("zh-CN", HelperLocale.zhHans), ("zh-SG", .zhHans), ("zh-Hans-CN", .zhHans), ("zh", .zhHans),
            ("zh-TW", .zhHant), ("zh-HK", .zhHant), ("zh-MO", .zhHant), ("ZH-hANT-TW", .zhHant),
            ("en-US", .en), ("ja-JP", .ja),
        ] {
            try expect(resolveLocale(requested: tag, preferred: []) == locale, "resolve \(tag)")
        }
        for tag in ["fr", "english", "ja--JP", "zh-CN\nInjected", "ja_JP", ""] {
            try expect(resolveLocale(requested: tag, preferred: ["fr", "zh-TW", "ja"]) == .zhHant,
                       "unrecognized locale falls back to preferred languages")
        }
        try expect(resolveLocale(requested: nil, preferred: ["ja-JP"]) == .ja, "omitted locale uses system preference")
        try expect(resolveLocale(requested: "fr", preferred: ["de"]) == .en, "English is the final fallback")
        for locale in HelperLocale.allCases {
            for text in HelperLocale.Text.allCases {
                try expect(!locale[text].isEmpty, "\(locale.rawValue) translates \(text)")
            }
        }
        try expect(sanitizeLabel("  Desk\u{0000}\u{0007}\n\t  \u{202E}\u{2066}\u{061C}取引\u{200F}\u{2069}  ") == "Desk 取引",
                   "remove control and bidi scalars and collapse whitespace")
        try expect(sanitizeLabel(String(repeating: "界", count: 70)) == String(repeating: "界", count: 64),
                   "labels are limited to 64 characters")
        try expect(sanitizeLabel(" \t\n\u{202E}\u{200B}\u{0301}") == nil, "invisible labels are rejected")
        try expect(sanitizeLabel(String(repeating: "x", count: 63) + " a") == String(repeating: "x", count: 63),
                   "clipping leaves no trailing space")
        let combining = try require(sanitizeLabel("a" + String(repeating: "\u{0301}", count: 300)), "combining label")
        try expect(combining.unicodeScalars.count == 256 && sanitizeLabel(combining) == combining,
                   "a single grapheme has bounded storage and idempotent sanitation")

        let encoded = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
        let key = try ControllerKey(encoded)
        try expect(key.fingerprint == "21FE-31DF-A154-A261-626B-F854-046F-D227" && ControllerKey.validFingerprint(key.fingerprint),
                   "fingerprint matches the first 16 SHA-256 bytes")
        try expect(try ControllerKey(encoded).fingerprint == key.fingerprint, "fingerprinting is deterministic")
        for malformed in ["21FE-31DF-A154", key.fingerprint.lowercased(), String(key.fingerprint.dropLast()),
                          key.fingerprint.replacingOccurrences(of: "D227", with: "ZZZZ"),
                          key.fingerprint.replacingOccurrences(of: "-", with: "")] {
            try expect(!ControllerKey.validFingerprint(malformed), "fingerprint syntax rejects \(malformed)")
        }
        for encoded in [
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "JuiVj8KyJ7BFw/SJ8u+Y8NXfrAXTxjM5sTgCiG1T/IU=", "xxdqcD1N2E+6PAt2DRBnDyogU/osOczGTsf9d5KsA3o=",
            "7P///////////////////////////////////////38=", "7f///////////////////////////////////////38=",
        ] {
            try rejects("invalid_request") { _ = try ControllerKey(encoded) }
        }
        try expect(ConsentMode.sessionOnly.choices == [.deny, .allowSession], "session-only choices")
        try expect(ConsentMode.persistentOnly.choices == [.deny, .allowPersistent], "persistent-only choices")
        try expect(ConsentMode.sessionOrPersistent.choices == [.deny, .allowSession, .allowPersistent],
                   "both approval choices follow deny")

        let host = ProcessIdentity(pid: 456, uid: 501, seconds: 1, microseconds: 0, executable: "/opt/Example/Rome",
                                   generation: ProcessGeneration(uniqueID: 1, idVersion: 0))
        let signing = Peer.SigningSummary(identifier: "com.example.rome", teamID: "ABCDEFG123", isAdHoc: false)
        for locale in HelperLocale.allCases {
            let claim = ControllerClaim(key: key, label: "Controller", scope: .remote)
            let prompt = ConsentPrompt(locale: locale, mode: .sessionOrPersistent,
                                       controller: claim, host: host, signingSummary: signing, deadline: .now())
            try expect(prompt.claimedSource == claim.label, "the consent identifies the proven controller's display claim")
            try expect(prompt.accessText == locale[.access] &&
                       prompt.persistentNotice?.contains(locale[.persistentAccess]) == true &&
                       prompt.persistentNotice?.contains(locale[.remoteRisk]) == true &&
                       !prompt.accessText.contains(host.executable) && !prompt.accessText.contains(claim.label),
                       "the system explanation stays distinct from the declared source and audit fields")
            let fingerprint = [locale.keyFingerprint("21FE-31DF-A154-A261"),
                               locale.keyFingerprint("626B-F854-046F-D227")].joined(separator: "\n")
            try expect(prompt.fingerprintLines == fingerprint, "consent displays all 128 fingerprint bits across two lines")
            try expect(prompt.verifiedExecutable == host.executable && prompt.verifiedSigningIdentifier == signing.identifier &&
                       prompt.verifiedTeam == "ABCDEFG123",
                       "full verified identity and fingerprint are directly available in \(locale.rawValue)")
        }
        let unsigned = ConsentPrompt(locale: .en, mode: .sessionOnly,
                                     controller: nil, host: host, signingSummary: nil, deadline: .now())
        try expect(unsigned.accessText == HelperLocale.en[.access] && unsigned.fingerprintLines == nil &&
                   unsigned.claimedSource == nil, "consent without a controller omits both the claim and the fingerprint")
        try expect(unsigned.verifiedExecutable == host.executable &&
                   unsigned.verifiedSigningIdentifier == unsigned.locale[.signingUnavailable] && unsigned.verifiedTeam == unsigned.locale[.noTeamID],
                   "missing signing metadata is visible without inventing a signer")
        try expect(auditDisplayValue("/tmp/Desk\n\u{202E}App") == "/tmp/Desk\\u{a}\\u{202e}App" &&
                   auditDisplayValue("/tmp/Desk\\u{a}") == "/tmp/Desk\\\\u{a}",
                   "audit fields visibly distinguish controls from literal escape sequences")
        let longPath = "/opt/" + String(repeating: "very-long-install-directory/", count: 8) + "bin/node"
        let longHost = ProcessIdentity(pid: host.pid, uid: host.uid, seconds: host.seconds, microseconds: host.microseconds,
                                       executable: longPath, generation: host.generation)
        let adHoc = Peer.SigningSummary(identifier: "node", teamID: nil, isAdHoc: true)
        let local = ConsentPrompt(locale: .zhHans, mode: .persistentOnly,
                                  controller: ControllerClaim(key: key, label: "Controller", scope: .local),
                                  host: longHost, signingSummary: adHoc, deadline: .now())
        try expect(local.persistentNotice == local.locale[.localRisk] && local.fingerprintLines != nil,
                   "persistent-only consent displays the local-key risk and fingerprint")
        try expect(local.verifiedExecutable == longPath && local.verifiedTeam == local.locale[.adHoc],
                   "consent preserves the full long path and distinguishes ad hoc signing")
        let translations: [(HelperLocale, String, String)] = [
            (.en, "Claimed by requester", "Always Allow This Source"),
            (.zhHans, "请求方声称", "总是允许该来源"),
            (.zhHant, "請求方聲稱", "一律允許此來源"),
            (.ja, "要求元の申告", "この接続元を常に許可"),
        ]
        for (locale, claimed, approval) in translations {
            try expect(locale[.claimedSource] == claimed &&
                       locale[ConsentDecision.allowPersistent.buttonTitle] == approval,
                       "consent separates the display claim from approval in \(locale.rawValue)")
        }

        func claimedSource(_ options: [String: Any]) throws -> String? {
            try Hello(JSONSerialization.data(withJSONObject: ["params": options]), preferred: []).controller?.label
        }
        try expect(try claimedSource(["source": "Rome Desktop"]) == nil && claimedSource(["source": 42]) == nil,
                   "legacy source fields never name an unauthenticated requester")
        for mode in [ConsentMode.sessionOnly, .persistentOnly, .sessionOrPersistent] {
            let label = try claimedSource(["consentMode": mode.rawValue,
                                           "controller": ["label": " Rome\n\u{202E} App ", "publicKey": encoded, "scope": "local"],
                                           "source": "Rome Desktop"])
            try expect(label == "Rome App", "only the sanitized controller label supplies a display claim in \(mode.rawValue)")
        }

        let privateKey = Curve25519.Signing.PrivateKey()
        let claim = ControllerClaim(key: try ControllerKey(privateKey.publicKey.rawRepresentation.base64EncodedString()),
                                    label: "Controller", scope: .remote)
        let start = DispatchTime(uptimeNanoseconds: 1)
        let challenge = ControllerChallenge(instance: "instance", helper: 123, host: 456, controller: claim,
                                            mode: .sessionOnly, now: start)
        let message = Data(["rome-computer-use-auth-v1", "instance", "123", "456", challenge.base64,
                            claim.key.base64, "remote", "session_only"].joined(separator: "\n").utf8)
        let signature = try privateKey.signature(for: message).base64EncodedString()
        try expect(challenge.verifies(signature, now: start + .seconds(59)), "proof works before expiration")
        try expect(!challenge.verifies(signature, now: start + .seconds(60)), "proof expires at the deadline")
    }

    private func trustedKeyStorage() throws {
        func key() throws -> ControllerKey {
            try ControllerKey(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString())
        }
        let first = try key()
        let other = try key()
        let remote = TrustedKeyRecord(key: first, label: "Remote", scope: .remote)
        let local = TrustedKeyRecord(key: first, label: "Local", scope: .local)
        let unrelated = TrustedKeyRecord(key: other, label: "Other", scope: .remote)
        let items = MemoryKeychainItems()
        let store = items.store

        try expect(try store.list().isEmpty && store.lookup(publicKey: first.base64) == nil, "empty service and missing account")
        try store.enroll(remote)
        try store.enroll(unrelated)
        let beforeLookup = items.calls.count
        try expect(try store.lookup(publicKey: first.base64) == remote, "lookup returns one account's JSON record")
        try expect(Array(items.calls.dropFirst(beforeLookup)) == [.copy(first.base64)], "lookup issues one account-scoped read")
        try store.enroll(local)
        try expect(Array(items.calls.suffix(2)) == [.add(first.base64), .update(first.base64)],
                   "duplicate enrollment updates the existing account")
        try expect(try store.lookup(publicKey: first.base64) == local && store.lookup(publicKey: other.base64) == unrelated,
                   "scope replacement leaves the other key intact")

        items.seed(account: "v1", data: try JSONEncoder().encode([remote]))
        items.seed(account: try key().base64, data: try JSONEncoder().encode(unrelated))
        try expect(try store.list().count == 2, "the list skips legacy or mismatched records")
        try store.revoke(fingerprint: local.fingerprint)
        try expect(items.calls.last == .delete(first.base64), "fingerprint revocation deletes only its full-key account")
        try store.revoke(fingerprint: local.fingerprint)
        try store.revoke(.publicKey(first.base64))
        try expect(try store.lookup(publicKey: first.base64) == nil && store.lookup(publicKey: other.base64) == unrelated,
                   "revoking a missing grant is idempotent")

        let beforeDelete = items.calls.count
        try store.revokeAll()
        try expect(Array(items.calls.dropFirst(beforeDelete)) == [.delete(nil)], "revoke-all uses one service-wide delete")
        try expect(try store.list().isEmpty, "revoke-all clears every account")
        try store.revokeAll()
        try expect(items.calls.last == .delete(nil), "revoke-all on an empty service succeeds")

        let missingEntitlement = KeychainTrustedKeyStore(accessGroup: nil, items: items)
        let beforeMissingEntitlement = items.calls.count
        try rejects("key_store_unavailable") { try missingEntitlement.revokeAll() }
        try expect(items.calls.count == beforeMissingEntitlement, "a missing access group never uses a wildcard")
        let readFailure = MemoryKeychainItems(copyError: errSecInteractionNotAllowed).store
        try rejects("key_store_unavailable") { _ = try readFailure.lookup(publicKey: first.base64) }
        try rejects("key_store_unavailable") { _ = try readFailure.list() }

        let revokedDuringUpdate = MemoryKeychainItems(removeOnUpdate: true)
        try revokedDuringUpdate.store.enroll(remote)
        try rejects("key_store_unavailable") { try revokedDuringUpdate.store.enroll(local) }
        try expect(try revokedDuringUpdate.store.lookup(publicKey: first.base64) == nil, "a revoked duplicate is never added again")

        let deleteFailure = MemoryKeychainItems(deleteError: errSecNotAvailable).store
        try deleteFailure.enroll(remote)
        try rejects("key_store_unavailable") { _ = try manageKeys(["--revoke-key", remote.fingerprint], store: deleteFailure) }
        try rejects("key_store_unavailable") { _ = try manageKeys(["--revoke-keys"], store: deleteFailure) }
        let admission = Admission()
        var feedback: String?
        var admissionSealed = false
        var terminatingAtFeedback = true
        revokeTrustedKeys(admission: admission, persistent: true, remove: {
            admissionSealed = admission.status()["stop"] as? String == "stop_confirmed"
            try deleteFailure.revokeAll()
        }, reportFailure: {
            feedback = $0
            terminatingAtFeedback = admission.terminating
        })
        try expect(admissionSealed && feedback == "key_store_unavailable" && !terminatingAtFeedback && !admission.terminating,
                   "menu revocation seals admission and reports a failed delete without exiting")
        try expect(try deleteFailure.lookup(publicKey: first.base64) == remote, "failed revocation leaves the grant in the store")
        let successfulRevocation = Admission()
        revokeTrustedKeys(admission: successfulRevocation, persistent: true, remove: { try store.revokeAll() },
                          reportFailure: { feedback = $0 })
        try expect(successfulRevocation.terminating, "a successful menu revocation ends the persistent session")
    }

    private func require<T>(_ value: T?, _ message: String) throws -> T {
        guard let value else { throw Failure("self-test: \(message)") }
        return value
    }

    private func decode(_ data: Data) throws -> ([String: Any], Data) {
        let (json, binary) = try Wire.lengths(data.prefix(8), request: false)
        try expect(data.count == 8 + json + binary, "frame uses both lengths")
        guard let result = try JSONSerialization.jsonObject(with: data[8..<(8 + json)]) as? [String: Any]
        else { throw Failure("self-test: invalid JSON") }
        return (result, data.suffix(binary))
    }

    private func frames() throws {
        let (normal, flat) = try decode(Wire.reply("normal", result: ["ready": true]))
        try expect(normal["v"] as? Int == 1 && normal["id"] as? String == "normal" && normal["ok"] as? Bool == true,
                   "normal envelope")
        try expect(flat.isEmpty, "normal has no binary")
        let (failed, none) = try decode(Wire.failure("failed", "window_unavailable"))
        try expect(failed["ok"] as? Bool == false &&
                   (failed["error"] as? [String: String])?["code"] == "window_unavailable" &&
                   failed["result"] == nil && none.isEmpty, "failure envelope")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=")!
        let image = try Wire.Image(png: png, width: 1, height: 1)
        let screenshot = try Wire.reply("capture", result: ["binding": "a"], image: image)
        let (capture, bytes) = try decode(screenshot)
        let result = capture["result"] as? [String: Any]
        let descriptor = result?["screenshot"] as? [String: Any]
        try expect(capture["ok"] as? Bool == true && result?["binding"] as? String == "a" &&
                   descriptor?["mimeType"] as? String == "image/png" && descriptor?["width"] as? Int == 1 &&
                   descriptor?["height"] as? Int == 1 && descriptor?["bytes"] as? Int == png.count &&
                   bytes == png, "screenshot uses same envelope and raw PNG payload")
        try rejects("frame_limit") { _ = try Wire.lengths(screenshot.prefix(8), request: true) }
        try rejects("invalid_frame") { _ = try Wire.lengths(Data(), request: false) }
        try rejects("frame_limit") { _ = try Wire.lengths(Data([0, 4, 0, 1, 0, 0, 0, 0]), request: false) }
        try rejects("frame_limit") { _ = try Wire.lengths(Data([0, 0, 0, 1, 0, 128, 0, 1]), request: false) }
        try rejects("capture_limit") { _ = try Wire.Image(png: png, width: 2, height: 1) }
        try rejects("capture_limit") { _ = try Wire.Image(png: Data(count: Wire.imageLimit + 1), width: 1, height: 1) }
        try rejects("capture_limit") { try Wire.Image.checkSize(2049, 1) }
        try rejects("capture_limit") { try Wire.Image.checkSize(2048, 1537) }
        try rejects("capture_limit") { try Wire.Image.checkSize(0, 1) }
        let request = try Wire.request(Data(#"{"v":1,"id":"a","method":"act","params":{"value":true}}"#.utf8))
        if case .checked(true) = request.params?.value { assertions += 1 }
        else { throw Failure("self-test: request boolean") }
    }

    private func admission() throws {
        let gate = Admission()
        try expect(!gate.needsAccessCheck, "idle admission needs no console scan")
        try gate.begin()
        try expect(gate.needsAccessCheck, "an active slot needs a console scan")
        gate.finish(hasBinding: true)
        try expect(gate.needsAccessCheck, "a live binding needs a console scan")
        try gate.begin()
        try rejects("busy") { try gate.begin() }
        let cancelled = gate.stop()
        try expect(cancelled["stop"] as? String == "cancel_requested", "cancel while slot is active")
        try expect(!gate.needsAccessCheck, "sealed admission needs no console scan")
        try rejects("session_stopped") { try gate.check() }
        gate.finish(hasBinding: false)
        try expect(gate.status()["stop"] as? String == "stop_confirmed", "confirm once slot retires")
        try rejects("session_stopped") { try gate.begin() }

        let idle = Admission()
        let ended = EndedBindings()
        idle.updateBindings(true)
        idle.whenStopped { ended.record("cleanup") }
        try expect(idle.stop()["stop"] as? String == "cancel_requested", "stop waits for idle bindings to clear")
        idle.terminate("local_stop")
        try expect(ended.drain() == ["cleanup"] && idle.terminating, "stop and terminate schedule one cleanup")
        idle.updateBindings(false)
        try expect(idle.status()["stop"] as? String == "stop_confirmed", "stop confirms once bindings clear")
        let early = Admission()
        _ = early.stop()
        early.whenStopped { ended.record("late observer") }
        try expect(ended.drain() == ["late observer"], "cleanup observes a stop that happened before registration")
    }

    private func transport() throws {
        var template = Array("/private/tmp/rome-native.XXXXXX".utf8CString)
        let path = try template.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress, let temporary = mkdtemp(base) else { throw Failure("self-test: mkdtemp") }
            return String(cString: temporary)
        }
        defer { try? FileManager.default.removeItem(atPath: path) }
        let socket = path + "/helper.sock"
        let link = path + "/alias"
        try expect(chmod(path, 0o755) == 0, "set unsafe mode")
        try rejects("unsafe_state_directory") { _ = try StateDirectory(path) }
        try expect(chmod(path, 0o700) == 0, "restore private mode")
        try expect(symlink(path, link) == 0, "make directory alias")
        try rejects("unsafe_state_directory") { _ = try StateDirectory(link) }
        try rejects("unsafe_state_directory") { _ = try StateDirectory(link + "/..") }

        try bootstrap(path)

        var pair: [Int32] = [-1, -1]
        try expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0, "socket pair")
        defer { pair.forEach { close($0) } }
        let me = try ProcessIdentity.read(getpid())
        let other = ProcessIdentity(pid: me.pid + 1, uid: me.uid, seconds: me.seconds,
                                    microseconds: me.microseconds, executable: me.executable, generation: me.generation)
        let first = try Peer.authenticate(pair[0], expecting: me, signed: false)
        let second = try Peer.authenticate(pair[1], expecting: me, signed: false)
        try expect(first.audit == second.audit && first.identity == me, "both endpoints bind to audit identity")
        try rejects("peer_rejected") { _ = try Peer.authenticate(pair[1], expecting: other, signed: false) }

        try runServer(path, socket: socket, mode: .wrongProof)
        try runServer(path, socket: socket, mode: .localStop)
        try runServer(path, socket: socket, mode: .replaceSocket)
        try runServer(path, socket: socket, mode: .disconnect)
        try runServer(path, socket: socket, mode: .terminate)
        try runServer(path, socket: socket, mode: .consentDenied)
        try runServer(path, socket: socket, mode: .consentDisconnect)
        try runServer(path, socket: socket, mode: .consentTerminate)
        try runServer(path, socket: socket, mode: .consentStop)
        try execConnection(path, executable: me.executable)
        try controllerTransport(path)
    }

    private final class ConsentProbe: @unchecked Sendable {
        private let lock = NSLock()
        private var received: [ConsentPrompt] = []

        var prompts: [ConsentPrompt] { lock.withLock { received } }

        func provider(_ decision: ConsentDecision) -> ConsentProvider {
            { prompt, _ in
                self.lock.withLock { self.received.append(prompt) }
                return decision
            }
        }
    }

    private func withControllerSocket(_ path: String, store: KeychainTrustedKeyStore, consent: @escaping ConsentProvider,
                                      _ test: (Int32, Admission, SymmetricKey) throws -> Void) throws {
        let listener = try Listener(state: StateDirectory(path))
        defer { listener.removeSocket() }
        let host = try ProcessIdentity.read(getpid())
        let key = SymmetricKey(size: .bits256)
        let admission = Admission()
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure("self-test: controller socket") }
        let done = DispatchGroup()
        defer {
            _ = shutdown(fd, SHUT_RDWR)
            close(fd)
            admission.terminate()
            _ = done.wait(timeout: .now() + .seconds(3))
        }
        var noSignal: Int32 = 1
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        try expect(setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal))) == 0 &&
                   setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
                   "controller fixture has a bounded read")
        try expect(try socketAddress(path + "/helper.sock", { connect(fd, $0, $1) }) == 0, "connect controller socket")
        done.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            defer { done.leave() }
            do {
                try serve(listener: listener, host: host, handshake: Handshake(key: key, host: host.pid),
                          admission: admission, desktop: nil, store: store, consent: consent)
            } catch {
                _ = admission.stop((error as? Failure)?.code ?? "internal_error")
            }
        }
        try test(fd, admission, key)
        _ = shutdown(fd, SHUT_RDWR)
        try expect(done.wait(timeout: .now() + .seconds(3)) == .success, "controller helper drains after disconnect")
    }

    private func controllerTransport(_ path: String) throws {
        let store = MemoryKeychainItems().store
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.rawRepresentation.base64EncodedString()
        let fingerprint = try ControllerKey(publicKey).fingerprint
        let controller = ["publicKey": publicKey, "label": "  Desk\n\u{202E} Controller  ", "scope": "remote"]
        let mode = ConsentMode.sessionOrPersistent
        var replay: String?
        var priorChallenge: String?

        func rpc(_ fd: Int32, _ method: String, _ params: [String: Any] = [:]) throws -> [String: Any] {
            try sendBytes(fd, Wire.frame(["v": 1, "id": method, "method": method, "params": params]))
            let header = try readBytes(fd, count: 8)
            let (length, binary) = try Wire.lengths(header, request: false)
            let (reply, _) = try decode(header + readBytes(fd, count: length))
            try expect(binary == 0 && reply["id"] as? String == method, "\(method) reply matches its request")
            return reply
        }

        func result(_ reply: [String: Any]) throws -> [String: Any] {
            try expect(reply["ok"] as? Bool == true, "successful controller RPC")
            return try require(reply["result"] as? [String: Any], "controller result")
        }

        func failed(_ reply: [String: Any], _ code: String) throws {
            try expect(reply["ok"] as? Bool == false && (reply["error"] as? [String: String])?["code"] == code,
                       "controller RPC fails with \(code)")
        }

        func closed(_ fd: Int32) throws {
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            var byte: UInt8 = 0
            try expect(poll(&event, 1, 2_000) > 0 && recv(fd, &byte, 1, MSG_DONTWAIT) == 0, "controller socket closes")
        }

        func hello(_ fd: Int32, _ key: SymmetricKey, _ options: [String: Any], method: String = "hello") throws -> [String: Any] {
            let nonce = Curve25519.Signing.PrivateKey().rawRepresentation.base64EncodedString()
            let host = String(getpid())
            let hostMessage = Data(["rome-computer-use-v1", "host", host, nonce].joined(separator: "\n").utf8)
            let mac = Data(HMAC<SHA256>.authenticationCode(for: hostMessage, using: key)).base64EncodedString()
            let params = options.merging(["nonce": nonce, "proof": mac]) { _, proven in proven }
            let reply = try rpc(fd, method, params)
            if let result = reply["result"] as? [String: Any] {
                let pid = try require(result["helperPid"] as? pid_t, "helper PID")
                let instance = try require(result["instance"] as? String, "instance")
                let proof = try require(result["helperProof"] as? String, "helper proof")
                let message = Data(["rome-computer-use-v1", "helper", host, String(pid), nonce, instance].joined(separator: "\n").utf8)
                let expected = Data(HMAC<SHA256>.authenticationCode(for: message, using: key)).base64EncodedString()
                try expect(pid == getpid() && proof == expected, "verify the helper HMAC")
                try expect(result["pid"] == nil && result["proof"] == nil, "hello returns only the canonical helper fields")
            }
            return reply
        }

        func challenge(_ fd: Int32, _ key: SymmetricKey, _ consentMode: ConsentMode = .sessionOrPersistent,
                       claim: [String: String]? = nil) throws -> [String: Any] {
            let reply = try result(hello(fd, key, ["controller": claim ?? controller, "consentMode": consentMode.rawValue, "locale": "zh-CN"]))
            let encoded = try require(reply["challenge"] as? String, "challenge")
            try expect(reply["status"] as? String == "challenge_required" && reply["locale"] as? String == "zh-Hans",
                       "hello requests proof of possession in the resolved locale")
            try expect(Data(base64Encoded: encoded)?.count == 32 && encoded != priorChallenge &&
                       reply["fingerprint"] as? String == fingerprint, "each challenge has 32 fresh bytes and a fingerprint")
            priorChallenge = encoded
            return reply
        }

        func sign(_ reply: [String: Any], mode: ConsentMode = .sessionOrPersistent, scope: String = "remote",
                  signer: Curve25519.Signing.PrivateKey? = nil) throws -> Data {
            let instance = try require(reply["instance"] as? String, "sign the helper instance")
            let pid = try require(reply["helperPid"] as? pid_t, "sign the helper PID")
            let nonce = try require(reply["challenge"] as? String, "sign the challenge")
            let message = Data(["rome-computer-use-auth-v1", instance, String(pid), String(getpid()),
                                nonce, publicKey, scope, mode.rawValue].joined(separator: "\n").utf8)
            return try (signer ?? privateKey).signature(for: message)
        }

        func answer(_ fd: Int32, _ signature: Data) throws -> [String: Any] {
            try rpc(fd, "authorize", ["signature": signature.base64EncodedString()])
        }

        func granted(_ reply: [String: Any], auth: String, enrolled: Bool, scope: String = "remote") throws {
            let grant = try result(reply)
            try expect(grant["auth"] as? String == auth && grant["enrolled"] as? Bool == enrolled &&
                       grant["label"] as? String == "Desk Controller" && grant["scope"] as? String == scope &&
                       grant["fingerprint"] as? String == fingerprint && grant["locale"] as? String == "zh-Hans",
                       "controller grant records its source, scope and locale")
        }

        let legacy = ConsentProbe()
        try withControllerSocket(path, store: store, consent: legacy.provider(.allowSession)) { fd, _, key in
            let grant = try result(hello(fd, key, ["locale": "ja-JP"]))
            try expect(grant["auth"] as? String == "session" && grant["locale"] as? String == "ja" &&
                       grant["challenge"] == nil, "hello without a controller directly grants a session")
        }
        try expect(legacy.prompts.count == 1 && legacy.prompts.first?.controller == nil &&
                   legacy.prompts.first?.mode == .sessionOnly, "hello without a controller uses session-only consent")
        try expect(try legacy.prompts.first?.host == ProcessIdentity.read(getpid()), "session consent receives the authenticated host")
        let introduced = ConsentProbe()
        try withControllerSocket(path, store: store, consent: introduced.provider(.allowSession)) { fd, _, key in
            let grant = try result(hello(fd, key, ["source": "Desk\n Helper"]))
            try expect(grant["auth"] as? String == "session" && grant["label"] == nil,
                       "an ignored legacy source preserves the session-only reply")
        }
        try expect(introduced.prompts.first?.claimedSource == nil &&
                   introduced.prompts.first?.label == legacy.prompts.first?.label,
                   "an unauthenticated source cannot replace the authenticated host's display identity")

        let invalid = ConsentProbe()
        try withControllerSocket(path, store: store, consent: invalid.provider(.allowSession)) { fd, _, key in
            try failed(hello(fd, key, [:], method: "handshake"), "authentication_failed")
            try closed(fd)
        }
        for options: [String: Any] in [
            ["consentMode": "persistent_only"], ["consentMode": "session_or_persistent"],
            ["controller": controller, "consentMode": "always"], ["controller": NSNull()],
            ["controller": controller, "consentMode": NSNull()], ["locale": 8],
            ["controller": controller.merging(["publicKey": "AAAA"]) { _, new in new }],
            ["controller": controller.merging(["scope": "other"]) { _, new in new }],
            ["controller": controller.merging(["label": "\n\u{202E}"]) { _, new in new }],
        ] {
            try withControllerSocket(path, store: store, consent: invalid.provider(.allowPersistent)) { fd, _, key in
                try failed(hello(fd, key, options), "invalid_request")
                try closed(fd)
            }
        }
        try expect(invalid.prompts.isEmpty && (try store.list()).isEmpty, "invalid hellos never prompt or enroll")

        let denied = ConsentProbe()
        for scenario in ["tampered", "wrong-key", "wrong-mode", "wrong-scope", "malformed"] {
            try withControllerSocket(path, store: store, consent: denied.provider(.allowPersistent)) { fd, _, key in
                let pending = try challenge(fd, key)
                var signature: Data
                switch scenario {
                case "wrong-key": signature = try sign(pending, signer: .init())
                case "wrong-mode": signature = try sign(pending, mode: .sessionOnly)
                case "wrong-scope": signature = try sign(pending, scope: "local")
                case "malformed": signature = Data(count: 63)
                default:
                    signature = try sign(pending)
                    signature[0] ^= 1
                    for method in ["windows", "bind", "unbind", "observe", "act", "input", "status", "cancel", "hello"] {
                        try failed(rpc(fd, method), "auth_required")
                    }
                    try expect(denied.prompts.isEmpty, "preauthorization calls never prompt")
                }
                try failed(answer(fd, signature), "auth_failed")
                try closed(fd)
            }
        }
        try withControllerSocket(path, store: store, consent: denied.provider(.allowPersistent)) { fd, _, key in
            _ = try challenge(fd, key)
            try failed(rpc(fd, "authorize", ["signature": 1]), "auth_failed")
            try closed(fd)
        }
        try withControllerSocket(path, store: store, consent: denied.provider(.allowPersistent)) { fd, _, key in
            _ = try challenge(fd, key)
            try expect(try result(rpc(fd, "stop"))["stop"] as? String == "stop_confirmed", "pending authorization accepts stop")
            try closed(fd)
        }
        try expect(denied.prompts.isEmpty && (try store.list()).isEmpty, "failed or stopped proofs never prompt or enroll")

        let ephemeral = ConsentProbe()
        for choice in [ConsentMode.sessionOnly, .sessionOrPersistent] {
            try withControllerSocket(path, store: store, consent: ephemeral.provider(.allowSession)) { fd, _, key in
                let pending = try challenge(fd, key, choice)
                let signature = try sign(pending, mode: choice)
                try granted(answer(fd, signature), auth: "session", enrolled: false)
                try failed(rpc(fd, "windows"), "desktop_disabled")
                try failed(answer(fd, signature), "auth_failed")
                replay = signature.base64EncodedString()
                try closed(fd)
            }
        }
        try expect(ephemeral.prompts.map(\.mode) == [.sessionOnly, .sessionOrPersistent] && (try store.list()).isEmpty,
                   "session approval never enrolls and a new connection prompts again")
        try withControllerSocket(path, store: store, consent: denied.provider(.allowPersistent)) { fd, _, key in
            _ = try challenge(fd, key)
            try failed(rpc(fd, "authorize", ["signature": try require(replay, "previous signature")]), "auth_failed")
            try closed(fd)
        }
        try expect(denied.prompts.isEmpty, "a proof replayed on a new connection never prompts")

        let incompatible = ConsentProbe()
        try withControllerSocket(path, store: store, consent: incompatible.provider(.allowSession)) { fd, _, key in
            let pending = try challenge(fd, key, .persistentOnly)
            try failed(answer(fd, sign(pending, mode: .persistentOnly)), "consent_denied")
            try closed(fd)
        }
        try expect(incompatible.prompts.first?.mode == .persistentOnly && (try store.list()).isEmpty,
                   "a provider cannot return a choice missing from the dialog")

        let enrollment = ConsentProbe()
        try withControllerSocket(path, store: store, consent: enrollment.provider(.allowPersistent)) { fd, _, key in
            let pending = try challenge(fd, key, .persistentOnly)
            try granted(answer(fd, sign(pending, mode: .persistentOnly)), auth: "persistent", enrolled: true)
        }
        let enrolled = try require(store.lookup(publicKey: publicKey), "saved record")
        try expect(enrollment.prompts.count == 1 && enrolled.label == "Desk Controller" && enrolled.scope == .remote,
                   "the first persistent approval stores the sanitized claim")
        let summary = try require(manageKeys(["--list-keys"], store: store), "key list output")
        let entries = try require(JSONSerialization.jsonObject(with: summary) as? [[String: Any]], "key list JSON")
        try expect(entries.count == 1 && Set(entries[0].keys) == Set(["fingerprint", "label", "scope", "enrolledAt"]),
                   "key list only exposes summary fields")
        try rejects("invalid_request") { _ = try manageKeys(["--revoke-key", "invalid"], store: store) }
        try rejects("invalid_request") { _ = try manageKeys(["--enroll-key", publicKey], store: store) }

        let silent = ConsentProbe()
        try withControllerSocket(path, store: store, consent: silent.provider(.deny)) { fd, admission, key in
            let renamed = controller.merging(["label": "Supplied display name"]) { _, new in new }
            let pending = try challenge(fd, key, .sessionOnly, claim: renamed)
            try granted(answer(fd, sign(pending, mode: .sessionOnly)), auth: "persistent", enrolled: false)
            try expect(silent.prompts.isEmpty, "matching key and scope bypass the consent provider")
            try expect(try store.list() == [enrolled], "using a matching key preserves its original label and timestamp")
            _ = try manageKeys(["--revoke-key", fingerprint], store: store)
            try closed(fd)
            try expect(admission.status()["reason"] as? String == "key_revoked", "revoking the key stops an active persistent session")
        }
        let afterRevocation = ConsentProbe()
        try withControllerSocket(path, store: store, consent: afterRevocation.provider(.deny)) { fd, _, key in
            try failed(answer(fd, sign(challenge(fd, key))), "consent_denied")
            try closed(fd)
        }
        try expect(afterRevocation.prompts.count == 1 && (try store.list()).isEmpty, "the revoked key prompts again")

        let scopeChange = ConsentProbe()
        let local = controller.merging(["scope": "local"]) { _, new in new }
        try store.enroll(enrolled)
        try withControllerSocket(path, store: store, consent: scopeChange.provider(.allowPersistent)) { fd, admission, key in
            let pending = try challenge(fd, key, mode, claim: local)
            try granted(answer(fd, sign(pending, scope: "local")), auth: "persistent", enrolled: true, scope: "local")
            try expect(scopeChange.prompts.first?.controller?.scope == .local && (try store.list()).first?.scope == .local,
                       "a scope change requires explicit approval and replaces the record")
            _ = try manageKeys(["--revoke-keys"], store: store)
            try closed(fd)
            try expect(admission.status()["reason"] as? String == "key_revoked", "revoke all stops a persistent session")
        }
        try withControllerSocket(path, store: store, consent: afterRevocation.provider(.deny)) { fd, _, key in
            try failed(answer(fd, sign(challenge(fd, key, mode, claim: local), scope: "local")), "consent_denied")
            try closed(fd)
        }
        try expect(afterRevocation.prompts.count == 2 && (try store.list()).isEmpty, "all revoked keys require consent")

        for _ in 0..<32 {
            let rawKey = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
            let other = try ControllerKey(rawKey.base64EncodedString())
            try store.enroll(TrustedKeyRecord(key: other, label: "Other", scope: .local))
        }
        try withControllerSocket(path, store: store, consent: enrollment.provider(.allowPersistent)) { fd, _, key in
            try failed(answer(fd, sign(challenge(fd, key))), "trusted_key_limit")
            try closed(fd)
        }
        try expect(try store.list().count == 32, "a failed persistent write closes the session without changing the store")
    }

    private func execConnection(_ path: String, executable: String) throws {
        let admission = Admission()
        let listener = try Listener(state: StateDirectory(path))
        defer { listener.removeSocket() }
        let command = Pipe()
        let ready = Pipe()
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = ["--self-test-exec-peer", path + "/helper.sock"]
        child.standardInput = command
        child.standardOutput = ready
        try child.run()
        defer {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
        }
        func marker(_ expected: UInt8) throws {
            let fd = ready.fileHandleForReading.fileDescriptor
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            try expect(poll(&event, 1, 3_000) > 0, "exec fixture responds")
            try expect(try readBytes(fd, count: 1) == Data([expected]), "exec fixture reaches expected phase")
        }
        try marker(1)
        let original = try ProcessIdentity.read(child.processIdentifier)
        let (fd, peer) = try listener.acceptHost(original, admission: admission, signed: false)
        let connection = try Connection(fd: fd, listener: listener, peer: peer, admission: admission)
        try connection.verify()
        try command.fileHandleForWriting.write(contentsOf: Data([1]))
        try marker(2)
        let current = try ProcessIdentity.read(child.processIdentifier)
        try expect(current.pid == original.pid && current.uid == original.uid &&
                   current.executable == original.executable && current.seconds == original.seconds &&
                   current.microseconds == original.microseconds, "same-path exec preserves the legacy identity")
        try expect(current.generation.idVersion != original.generation.idVersion, "exec advances the audit PID version")
        try rejects("process_identity_changed") { try connection.verify() }
        try rejects("process_identity_changed") { try admission.begin() }
        child.waitUntilExit()
        try expect(child.terminationStatus == 0, "the inherited socket observes the server closing it")
        print("Same-path exec with an inherited socket is rejected.")
    }

    static func execPeer(_ socket: String) throws -> Never {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0, try socketAddress(socket, { connect(fd, $0, $1) }) == 0 else {
            throw Failure("self-test: exec fixture connection")
        }
        try FileHandle.standardOutput.write(contentsOf: Data([1]))
        _ = try readBytes(STDIN_FILENO, count: 1)
        let executable = try ProcessIdentity.read(getpid()).executable
        var arguments = [strdup(executable), strdup("--self-test-exec-ready"), strdup(String(fd)), nil]
        defer { arguments.forEach { free($0) } }
        _ = arguments.withUnsafeMutableBufferPointer { execv(executable, $0.baseAddress!) }
        throw Failure("self-test: same-path exec failed")
    }

    static func inheritedSocket(_ fd: Int32) throws {
        var address = sockaddr_un()
        var length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getpeername(fd, $0, &length) }
        }
        guard connected == 0 else { throw Failure("self-test: missing inherited connection") }
        try FileHandle.standardOutput.write(contentsOf: Data([2]))
        var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        var byte: UInt8 = 0
        guard poll(&event, 1, 3_000) > 0, recv(fd, &byte, 1, MSG_DONTWAIT) == 0 else {
            throw Failure("self-test: inherited connection stayed open")
        }
    }

    private func writeBootstrap(_ path: String, _ data: Data) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure("self-test: create bootstrap") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: data)
        try handle.close()
    }

    private func bootstrapData(secret: String, pid: pid_t, executable: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["secret": secret, "hostPid": pid, "hostExecutable": executable])
    }

    private func bootstrap(_ path: String) throws {
        let state = try StateDirectory(path)
        let file = path + "/bootstrap.json"
        let alias = path + "/bootstrap-target"
        let host = try ProcessIdentity.read(getpid())
        let secret = String(repeating: "a1", count: 32)
        let valid = try bootstrapData(secret: secret, pid: host.pid, executable: host.executable)

        try writeBootstrap(file, valid)
        try expect(chmod(file, 0o644) == 0, "change bootstrap mode")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
        try expect(chmod(file, 0o600) == 0, "restore bootstrap mode")
        try expect(link(file, alias) == 0, "make hard link to bootstrap")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
        try expect(unlink(file) == 0 && symlink(alias, file) == 0, "make symlink to bootstrap")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
        try expect(FileManager.default.fileExists(atPath: alias), "bootstrap symlink target stays intact")
        try expect(unlink(file) == 0 && unlink(alias) == 0, "clean aliased bootstrap")

        let expired = Process()
        expired.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try expired.run()
        expired.waitUntilExit()
        for invalid in [
            Data("{".utf8),
            Data(count: 16385),
            try bootstrapData(secret: secret.uppercased(), pid: host.pid, executable: host.executable),
            try bootstrapData(secret: secret, pid: host.pid, executable: "/usr/bin/true"),
            try bootstrapData(secret: secret, pid: expired.processIdentifier, executable: "/usr/bin/true"),
        ] {
            try writeBootstrap(file, invalid)
            try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
            try expect(!FileManager.default.fileExists(atPath: file), "consume bootstrap before validating its contents")
        }
        try writeBootstrap(file, valid)
        let bootstrap = try state.consumeBootstrap()
        try expect(bootstrap.host == host, "bootstrap pins the host identity")
        try expect(bootstrap.key.withUnsafeBytes { $0.allSatisfy { $0 == 0xa1 } }, "decode lowercase hex key")
        try expect(!FileManager.default.fileExists(atPath: file), "valid bootstrap is consumed once")
        try rejects("authentication_failed") { _ = try state.consumeBootstrap() }
    }

    static func consentProvider(_ mode: String, path: String) throws -> ConsentProvider {
        switch mode {
        case "allow": return { _, _ in .allowSession }
        case "deny": return { _, _ in .deny }
        case "unexpected": return { _, _ in exit(99) }
        case "wait":
            return { _, canContinue in
                if !FileManager.default.createFile(atPath: path + "/consent-waiting", contents: Data()) { return .deny }
                while canContinue() { usleep(10_000) }
                return .allowSession
            }
        default: throw Failure("self-test: invalid consent fixture")
        }
    }

    private enum Mode {
        case wrongProof, localStop, replaceSocket, disconnect, terminate
        case consentDenied, consentDisconnect, consentTerminate, consentStop

        var provider: String {
            switch self {
            case .wrongProof: "unexpected"
            case .consentDenied: "deny"
            case .consentDisconnect, .consentTerminate, .consentStop: "wait"
            default: "allow"
            }
        }
    }

    private func runServer(_ path: String, socket: String, mode: Mode) throws {
        let key = SymmetricKey(size: .bits256)
        let secret = key.withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() }
        let host = try ProcessIdentity.read(getpid())
        let bootstrap = path + "/bootstrap.json"
        try writeBootstrap(bootstrap, bootstrapData(secret: secret, pid: host.pid, executable: host.executable))

        // The launcher is the helper's parent, while this process owns the socket and key.
        let child = Process()
        let pidOutput = Pipe()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", #""$@" >/dev/null & server=$!; printf '%s\n' "$server"; exec >&-; wait "$server""#,
                           "rome-native-test", host.executable, "--self-test-server", path, mode.provider]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = pidOutput
        try child.run()
        var helper: pid_t?
        defer {
            if child.isRunning { kill(helper ?? child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
        }
        guard let output = try pidOutput.fileHandleForReading.read(upToCount: 32),
              let pid = pid_t(String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0 else { throw Failure("self-test: missing helper pid") }
        helper = pid

        let deadline = DispatchTime.now() + .seconds(5)
        var fd: Int32 = -1
        while child.isRunning, DispatchTime.now() < deadline {
            let candidate = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard candidate >= 0 else { throw Failure("self-test: socket") }
            if try socketAddress(socket, { connect(candidate, $0, $1) }) == 0 {
                fd = candidate
                break
            }
            close(candidate)
            usleep(10_000)
        }
        try expect(fd >= 0, "connect to helper for \(mode)")
        defer { if fd >= 0 { close(fd) } }
        try expect(!FileManager.default.fileExists(atPath: bootstrap), "bootstrap removed before handshake")
        if mode == .disconnect {
            let contender = try StateDirectory(path)
            try expect(flock(contender.fd, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK,
                       "helper holds the state directory lock")
        }
        var noSignal: Int32 = 1
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        try expect(setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout.size(ofValue: noSignal))) == 0,
                   "suppress SIGPIPE")
        try expect(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
                   "bound test read")
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        try expect(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size &&
                   info.pbi_ppid == UInt32(child.processIdentifier), "host and launcher have different PIDs")
        let target = try ProcessIdentity.read(pid)
        let peer = try Peer.authenticate(fd, expecting: target, signed: false)
        try expect(peer.identity == target, "host verifies helper peer")

        func response(_ method: String) throws -> [String: Any] {
            let (length, binary) = try Wire.lengths(readBytes(fd, count: 8), request: false)
            let data = try readBytes(fd, count: length)
            guard binary == 0, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  result["id"] as? String == method else { throw Failure("self-test: bad \(method) reply") }
            return result
        }

        func rpc(_ method: String, params: [String: Any] = [:]) throws -> [String: Any] {
            try sendBytes(fd, Wire.frame(["v": 1, "id": method, "method": method, "params": params]))
            return try response(method)
        }

        let nonce = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        func mac(_ fields: [String]) -> Data {
            let payload = Data((["rome-computer-use-v1"] + fields).joined(separator: "\n").utf8)
            return Data(HMAC<SHA256>.authenticationCode(for: payload, using: key))
        }
        let nonceText = nonce.base64EncodedString()
        let proof = mode == .wrongProof ? Data(count: 32) : mac(["host", String(host.pid), nonceText])
        try sendBytes(fd, Wire.frame(["v": 1, "id": "hello", "method": "hello", "params": [
            "nonce": nonceText, "proof": proof.base64EncodedString(),
        ]]))
        if mode.provider == "wait" {
            let marker = path + "/consent-waiting"
            let deadline = DispatchTime.now() + .seconds(2)
            while !FileManager.default.fileExists(atPath: marker), DispatchTime.now() < deadline { usleep(10_000) }
            try expect(unlink(marker) == 0, "provider waits after authentication")
            if mode == .consentDisconnect {
                var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                try expect(poll(&event, 1, 5_100) == 0, "consent can outlast the five-second handshake deadline")
                try expect(shutdown(fd, SHUT_WR) == 0, "disconnect while retaining the receive side")
            } else {
                try expect(kill(pid, mode == .consentStop ? SIGUSR1 : SIGTERM) == 0, "signal during consent")
            }
        }
        let reply = try response("hello")
        if mode == .wrongProof {
            try expect((reply["error"] as? [String: String])?["code"] == "authentication_failed", "refuse invalid proof")
        } else if mode.provider != "allow" {
            try expect(reply["v"] as? Int == 1 && reply["ok"] as? Bool == false &&
                       (reply["error"] as? [String: String])?["code"] == "consent_denied", "reject session after \(mode)")
            var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            var byte: UInt8 = 0
            try expect(poll(&event, 1, 2_000) > 0 && recv(fd, &byte, 1, MSG_DONTWAIT) == 0,
                       "consent denial seals and closes the session")
            print("Consent denial and shutdown verified for \(mode).")
        } else {
            let result = reply["result"] as? [String: Any]
            guard let instance = result?["instance"] as? String, let proofString = result?["helperProof"] as? String,
                  let proof = Data(base64Encoded: proofString) else { throw Failure("self-test: handshake result") }
            try expect(result?["helperPid"] as? Int32 == pid, "handshake pid")
            try expect(proof == mac(["helper", String(host.pid), String(pid), nonceText, instance]), "helper proof")
            try expect(proof != mac(["host", String(host.pid), nonceText]), "proofs are role separated")
            for method in ["windows", "bind", "unbind", "observe", "act"] {
                let disabled = try rpc(method)
                try expect((disabled["error"] as? [String: String])?["code"] == "desktop_disabled",
                           "test helper cannot contact desktop via \(method)")
            }
            if mode == .localStop {
                try expect(kill(pid, SIGUSR1) == 0, "send local stop signal")
                var stopped = false
                let stopDeadline = DispatchTime.now() + .seconds(2)
                while DispatchTime.now() < stopDeadline {
                    let status = try rpc("status")["result"] as? [String: Any]
                    if status?["stop"] as? String == "stop_confirmed" { stopped = true; break }
                    usleep(10_000)
                }
                try expect(stopped, "local stop closes admission")
                for method in ["cancel", "stop"] {
                    let stop = try rpc(method)["result"] as? [String: Any]
                    try expect(stop?["stop"] as? String == "stop_confirmed", "\(method) is idempotent")
                }
            } else if mode == .terminate {
                try expect(kill(pid, SIGTERM) == 0, "send terminate signal")
                var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                try expect(poll(&event, 1, 2_000) > 0, "terminate closes active socket")
                var byte: UInt8 = 0
                try expect(recv(fd, &byte, 1, 0) == 0, "no data follows terminate")
            } else if mode == .replaceSocket {
                try expect(rename(socket, socket + ".old") == 0, "unlink old socket name")
                let replacement = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
                guard replacement >= 0 else { throw Failure("self-test: replacement socket") }
                defer { close(replacement) }
                let oldMask = umask(0o177)
                defer { umask(oldMask) }
                try expect(try socketAddress(socket, { bind(replacement, $0, $1) }) == 0, "replace socket inode")
                var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                try expect(poll(&event, 1, 2_000) > 0, "replacement closes active socket")
                var byte: UInt8 = 0
                try expect(recv(fd, &byte, 1, 0) == 0, "replaced socket does not service requests")
            }
        }

        close(fd)
        fd = -1
        let exitDeadline = DispatchTime.now() + .seconds(3)
        while child.isRunning, DispatchTime.now() < exitDeadline { usleep(10_000) }
        try expect(!child.isRunning && child.terminationStatus == 0, "helper exits after \(mode)")
        if mode == .replaceSocket {
            try expect(FileManager.default.fileExists(atPath: socket), "helper preserves replacement socket")
            try expect(unlink(socket) == 0, "clean replacement test socket")
        } else {
            try expect(!FileManager.default.fileExists(atPath: socket), "helper cleans its socket")
        }
    }
}

final class MemoryKeychainItems: KeychainItems, @unchecked Sendable {
    enum Call: Equatable {
        case copy(String?), add(String), update(String), delete(String?)
    }

    private static let group = "TESTTEAMID.com.rome.computer-use"
    // The lock covers the item data and operation log shared by server and test threads.
    private let lock = NSLock()
    private var records: [String: Data] = [:]
    private var log: [Call] = []
    private let copyError: OSStatus?
    private let deleteError: OSStatus?
    private let removeOnUpdate: Bool

    init(copyError: OSStatus? = nil, deleteError: OSStatus? = nil, removeOnUpdate: Bool = false) {
        self.copyError = copyError
        self.deleteError = deleteError
        self.removeOnUpdate = removeOnUpdate
    }

    var store: KeychainTrustedKeyStore { KeychainTrustedKeyStore(accessGroup: Self.group, items: self) }
    var calls: [Call] { lock.withLock { log } }

    func seed(account: String, data: Data) { lock.withLock { records[account] = data } }

    private func scoped(_ query: [String: Any]) -> Bool {
        query[kSecClass as String] as? String == kSecClassGenericPassword as String &&
            query[kSecAttrService as String] as? String == "com.rome.computer-use.authorized-keys" &&
            query[kSecAttrAccessGroup as String] as? String == Self.group &&
            query[kSecUseDataProtectionKeychain as String] as? Bool == true &&
            query[kSecAttrSynchronizable as String] as? Bool == false
    }

    func copy(_ query: [String: Any]) -> (OSStatus, Any?) {
        lock.withLock {
            guard scoped(query), query[kSecReturnData as String] as? Bool == true else { return (errSecParam, nil) }
            let account = query[kSecAttrAccount as String] as? String
            log.append(.copy(account))
            if let copyError { return (copyError, nil) }
            if let account {
                guard let data = records[account] else { return (errSecItemNotFound, nil) }
                return (errSecSuccess, data)
            }
            guard query[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String,
                  query[kSecReturnAttributes as String] as? Bool == true else { return (errSecParam, nil) }
            if records.isEmpty { return (errSecItemNotFound, nil) }
            let entries: [[String: Any]] = records.map { account, data in
                [kSecAttrAccount as String: account, kSecValueData as String: data]
            }
            return (errSecSuccess, entries)
        }
    }

    func add(_ item: [String: Any]) -> OSStatus {
        lock.withLock {
            guard scoped(item), let account = item[kSecAttrAccount as String] as? String,
                  let data = item[kSecValueData as String] as? Data,
                  item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
            else { return errSecParam }
            log.append(.add(account))
            guard records[account] == nil else { return errSecDuplicateItem }
            records[account] = data
            return errSecSuccess
        }
    }

    func update(_ query: [String: Any], values: [String: Any]) -> OSStatus {
        lock.withLock {
            guard scoped(query), let account = query[kSecAttrAccount as String] as? String,
                  values.count == 1, let data = values[kSecValueData as String] as? Data else { return errSecParam }
            log.append(.update(account))
            if removeOnUpdate { records.removeValue(forKey: account) }
            guard records[account] != nil else { return errSecItemNotFound }
            records[account] = data
            return errSecSuccess
        }
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.withLock {
            guard scoped(query) else { return errSecParam }
            let account = query[kSecAttrAccount as String] as? String
            log.append(.delete(account))
            if let deleteError { return deleteError }
            if let account { return records.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess }
            guard !records.isEmpty else { return errSecItemNotFound }
            records.removeAll()
            return errSecSuccess
        }
    }
}
#endif
