import Foundation
import os
#if DEBUG
import SwiftUI
import UIKit
#endif

/// Debug builds only: with `ROME_PERF=<scenario>` and `ROME_DEMO=long-chat`,
/// the app drives one scenario for about 20 s, counts what it draws and
/// builds, measures frame gaps, and writes one line of results to the log
/// and to `tmp/perf-<scenario>.txt` in its container. `ios/README.md` lists
/// the scenarios. Release builds keep only an empty `count`.
enum PerfProbe {
    #if DEBUG
    nonisolated private static let counts = OSAllocatedUnfairLock(initialState: [String: Int]())
    nonisolated private static let scenario = ProcessInfo.processInfo.environment["ROME_PERF"]
    private static let log = Logger(subsystem: "cc.romeos.mobile", category: "Perf")

    /// Counts one run of `key` (a body, a build, a parse) while a scenario runs.
    @inline(__always)
    nonisolated static func count(_ key: String) {
        guard scenario != nil else { return }
        counts.withLock { $0[key, default: 0] += 1 }
    }
    #else
    @inline(__always)
    nonisolated static func count(_ key: String) {}
    #endif
}

#if DEBUG
extension PerfProbe {
    @MainActor private static var started = false

    /// Starts the scenario named by `ROME_PERF` once the main Chat has loaded.
    @MainActor
    static func start(model: AppModel) {
        guard let scenario, !started else { return }
        started = true
        Task { @MainActor in
            for _ in 0..<100 where model.workspace?.concierge.loaded != true { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .seconds(4))
            let frames = Frames()
            frames.start()
            try? await Task.sleep(for: .seconds(1))
            counts.withLock { $0 = [:] }
            frames.reset()
            let began = CACurrentMediaTime()
            await drive(scenario, model: model)
            let seconds = CACurrentMediaTime() - began
            frames.stop()
            var line = String(format: "PERF %@ secs=%.1f hitch_ms_per_s=%.1f worst_ms=%.0f frames=%d", scenario, seconds, frames.hitch / seconds, frames.worst, frames.count)
            for (key, value) in counts.withLock({ $0 }).sorted(by: { $0.key < $1.key }) { line += " \(key)=\(value)" }
            log.notice("\(line, privacy: .public)")
            try? line.write(toFile: NSTemporaryDirectory() + "perf-\(scenario).txt", atomically: true, encoding: .utf8)
        }
    }

    /// Frame gaps over 1.5 refresh intervals, as hitch time.
    @MainActor
    private final class Frames: NSObject {
        private var link: CADisplayLink?
        private var last: CFTimeInterval = 0
        private(set) var hitch: Double = 0
        private(set) var worst: Double = 0
        private(set) var count = 0

        func start() {
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        func stop() { link?.invalidate() }

        func reset() {
            hitch = 0
            worst = 0
            count = 0
            last = 0
        }

        @objc private func tick(_ link: CADisplayLink) {
            let interval = link.targetTimestamp - link.timestamp
            let frame = interval > 0 ? interval : 1.0 / 60
            if last > 0 {
                let gap = link.timestamp - last
                if gap > frame * 1.5 { hitch += (gap - frame) * 1000 }
                worst = max(worst, gap * 1000)
            }
            count += 1
            last = link.timestamp
        }
    }

    @MainActor
    private static func drive(_ scenario: String, model: AppModel) async {
        switch scenario {
        case "idle", "idle-apps":
            if scenario == "idle-apps" { model.debugCommand = .section(.apps) }
            try? await Task.sleep(for: .seconds(20))
        case "stream", "stream-apps":
            if scenario == "stream-apps" { model.debugCommand = .section(.apps) }
            for index in 0..<4 {
                _ = model.workspace?.concierge.send("Perf \(index)")
                try? await Task.sleep(for: .seconds(5))
            }
        case "taskstream":
            model.debugCommand = .route([.taskChat(chatId: "chat-price", title: "Task")])
            try? await Task.sleep(for: .seconds(3))
            for index in 0..<2 {
                _ = model.workspace?.taskStore("chat-price").send("Perf \(index)")
                try? await Task.sleep(for: .seconds(9))
            }
        case "sections":
            for index in 0..<12 {
                model.debugCommand = .section(index.isMultiple(of: 2) ? .apps : .chat)
                try? await Task.sleep(for: .milliseconds(1600))
            }
        case "settings":
            for index in 0..<24 {
                model.debugCommand = .settings(index.isMultiple(of: 2) ? [] : nil)
                try? await Task.sleep(for: .milliseconds(900))
            }
        case "scroll":
            for _ in 0..<80 {
                if let scroll = transcriptScroll() {
                    let top = max(-scroll.adjustedContentInset.top, scroll.contentOffset.y - 220)
                    UIView.animate(withDuration: 0.2) { scroll.contentOffset.y = top }
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        case "chats":
            // Opens and leaves 24 task chats, for the memory the kept stores take.
            let chats = (model.workspace?.tasks.tasks.compactMap(\.chat?.id) ?? []) + (0..<24).map { "perf-chat-\($0)" }
            for chatId in chats.prefix(24) {
                model.debugCommand = .route([.taskChat(chatId: chatId, title: "Task")])
                try? await Task.sleep(for: .milliseconds(600))
                model.debugCommand = .route([])
                try? await Task.sleep(for: .milliseconds(200))
            }
        default:
            try? await Task.sleep(for: .seconds(5))
        }
    }

    /// The tallest scroll view on screen: the transcript.
    @MainActor
    private static func transcriptScroll() -> UIScrollView? {
        var best: UIScrollView?
        func walk(_ view: UIView) {
            if let scroll = view as? UIScrollView, !(scroll is UITextView), scroll.window != nil,
               scroll.contentSize.height > (best?.contentSize.height ?? 0) {
                best = scroll
            }
            view.subviews.forEach(walk)
        }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        windows.forEach(walk)
        return best
    }
}
#endif
