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

    nonisolated private static let samples = OSAllocatedUnfairLock(initialState: [String: [Double]]())

    /// Records one measured value for `key`; the result line gives its
    /// count, smallest, mean and largest.
    nonisolated static func sample(_ key: String, _ value: Double) {
        guard scenario != nil else { return }
        samples.withLock { $0[key, default: []].append(value) }
    }
    #else
    @inline(__always)
    nonisolated static func count(_ key: String) {}
    @inline(__always)
    nonisolated static func sample(_ key: String, _ value: Double) {}
    #endif
}

#if DEBUG
extension PerfProbe {
    @MainActor private static var started = false
    /// A fling the `paging` scenarios start in code, which the list whose
    /// scroll view is the note's object takes as a drag.
    static let flingStarted = Notification.Name("RomePerfFlingStarted")

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
            samples.withLock { $0 = [:] }
            frames.reset()
            var began = CACurrentMediaTime()
            await drive(scenario, model: model) {
                // The scenario's setup is done: measure from here.
                counts.withLock { $0 = [:] }
                samples.withLock { $0 = [:] }
                frames.reset()
                began = CACurrentMediaTime()
            }
            let seconds = CACurrentMediaTime() - began
            frames.stop()
            var line = String(format: "PERF %@ secs=%.1f hitch_ms_per_s=%.1f worst_ms=%.0f frames=%d", scenario, seconds, frames.hitch / seconds, frames.worst, frames.count)
            for (key, value) in counts.withLock({ $0 }).sorted(by: { $0.key < $1.key }) { line += " \(key)=\(value)" }
            for (key, values) in samples.withLock({ $0 }).sorted(by: { $0.key < $1.key }) where !values.isEmpty {
                line += String(format: " %@=n%d/min%.0f/mean%.0f/max%.0f", key, values.count, values.min() ?? 0, values.reduce(0, +) / Double(values.count), values.max() ?? 0)
            }
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
    private static func drive(_ scenario: String, model: AppModel, measureFromHere: () -> Void) async {
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
        case "paging":
            // Twelve flings up through older pages, each a glide that slows
            // the way UIKit's does; `TranscriptScroll` logs each page.
            for _ in 0..<12 {
                if let scroll = transcriptScroll() {
                    NotificationCenter.default.post(name: flingStarted, object: scroll)
                    await Glide(scroll: scroll, speed: 6000).run()
                }
                try? await Task.sleep(for: .milliseconds(300))
            }
        case "pagingdown":
            // Up through older pages until 520 messages are held (past the
            // lazy switch), then from the top, measured: ten flings back down.
            for _ in 0..<60 where (model.workspace?.concierge.messages.count ?? 0) < 520 {
                if let scroll = transcriptScroll() {
                    NotificationCenter.default.post(name: flingStarted, object: scroll)
                    await Glide(scroll: scroll, speed: 6000).run()
                }
                try? await Task.sleep(for: .milliseconds(400))
            }
            if let scroll = transcriptScroll() {
                NotificationCenter.default.post(name: flingStarted, object: scroll)
                scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
            }
            try? await Task.sleep(for: .seconds(2))
            measureFromHere()
            if let scroll = transcriptScroll() { log.notice("pagingdown from \(scroll.contentOffset.y, privacy: .public) of \(scroll.contentSize.height, privacy: .public)") }
            for _ in 0..<10 {
                if let scroll = transcriptScroll() { await Glide(scroll: scroll, speed: -6000).run() }
                try? await Task.sleep(for: .milliseconds(300))
            }
            if let scroll = transcriptScroll() { log.notice("pagingdown to \(scroll.contentOffset.y, privacy: .public) of \(scroll.contentSize.height, privacy: .public)") }
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

    /// A fling up: the offset moves each frame and slows at UIKit's normal
    /// deceleration rate, until it stops or meets the top.
    @MainActor
    private final class Glide: NSObject {
        private let scroll: UIScrollView
        private var speed: Double
        private var last: CFTimeInterval = 0
        private var done: CheckedContinuation<Void, Never>?

        init(scroll: UIScrollView, speed: Double) {
            self.scroll = scroll
            self.speed = speed
        }

        func run() async {
            await withCheckedContinuation { continuation in
                done = continuation
                CADisplayLink(target: self, selector: #selector(tick(_:))).add(to: .main, forMode: .common)
            }
        }

        @objc private func tick(_ link: CADisplayLink) {
            if last > 0 {
                let dt = link.timestamp - last
                let top = -scroll.adjustedContentInset.top
                let end = max(top, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
                scroll.contentOffset.y = min(end, max(top, scroll.contentOffset.y - speed * dt))
                speed *= pow(UIScrollView.DecelerationRate.normal.rawValue, dt * 1000)
                // A positive speed flings up, toward older rows; a negative one down.
                let stopped = speed > 0 ? scroll.contentOffset.y <= top : scroll.contentOffset.y >= end
                if abs(speed) < 30 || stopped {
                    link.invalidate()
                    done?.resume()
                    done = nil
                }
            }
            last = link.timestamp
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
