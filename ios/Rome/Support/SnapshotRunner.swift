#if DEBUG
import SwiftUI
import UIKit

/// A screen change the snapshot runner asks the shell for.
enum DebugCommand: Equatable {
    case drawer(Bool)
    case tasks(Bool)
    case route([Route])
    /// One of the drawer's pages as the root, with nothing pushed.
    case section(MainSection)
    /// The Settings sheet with these pages pushed in it; nil closes it.
    case settings([SettingsRoute]?)
    /// Puts sample photos in Chat's composer.
    case composerPhotos(Int)
}

/// Debug builds only: with `ROME_SNAPSHOT_DIR` set, the app opens the demo data,
/// walks every screen in light and dark, and writes a PNG of each. It lets the
/// UI be reviewed where no simulator runs (Mac Catalyst).
@MainActor
enum SnapshotRunner {
    static var directory: URL? {
        ProcessInfo.processInfo.environment["ROME_SNAPSHOT_DIR"].map { URL(fileURLWithPath: $0) }
    }

    static var only: Set<String> {
        Set((ProcessInfo.processInfo.environment["ROME_SNAPSHOT_ONLY"] ?? "").split(separator: ",").map(String.init))
    }

    static func run(model: AppModel) async {
        guard let directory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        await sizeWindow()
        if ProcessInfo.processInfo.environment["ROME_SNAPSHOT_LIVE"] == "1" {
            await runLive(model: model, directory: directory)
            return
        }

        // Settings shows "Not set"; the Chat offer waits for its own screen.
        model.push.debugSet(permission: .notSet, dismissedAt: .now)
        let styles: [(String, UIUserInterfaceStyle)] = [("light", .light), ("dark", .dark)]
        for (styleName, style) in styles {
            window?.overrideUserInterfaceStyle = style
            await capture("01-login", style: styleName, in: directory) { model.debugSetPhase(.signedOut) }
            await capture("02-login-connecting", style: styleName, in: directory) { model.debugSetPhase(.connecting(host: "me.romeos.cc")) }
            await capture("03-login-stopped", style: styleName, in: directory) { model.debugSetPhase(.stopped(instanceName: String(localized: "My Rome"))) }

            model.openDemo()
            try? await Task.sleep(for: .seconds(2))
            await capture("04-chat", style: styleName, in: directory) {}
            await capture("30-composer-photos", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .composerPhotos(2) }
            model.debugCommand = .composerPhotos(0)
            try? await Task.sleep(for: .seconds(0.4))
            await capture("05-drawer", style: styleName, in: directory) { model.debugCommand = .drawer(true) }
            model.debugCommand = .drawer(false)
            try? await Task.sleep(for: .seconds(0.8))
            await capture("06-tasks", style: styleName, in: directory, wait: 1.6) { model.debugCommand = .tasks(true) }
            model.debugCommand = .tasks(false)
            try? await Task.sleep(for: .seconds(0.8))
            await capture("07-task-approval", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .route([.taskChat(chatId: "chat-price", title: "价格追踪：发提醒邮件")])
            }
            await capture("08-task-question", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .route([.taskChat(chatId: "chat-research", title: "竞品定价调研")])
            }
            await capture("09-task-running", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .route([.taskChat(chatId: "chat-site", title: "官网首页双语文案")])
            }
            await capture("10-task-failed", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .route([.taskChat(chatId: "chat-notion", title: "同步 Notion 数据库")])
            }
            await capture("11-settings", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .settings([]) }
            await capture("27-settings-notifications-on", style: styleName, in: directory, wait: 1.2) {
                model.push.debugSet(permission: .on, dismissedAt: .now)
                model.debugCommand = .settings(nil)
                Task {
                    try? await Task.sleep(for: .seconds(0.4))
                    model.debugCommand = .settings([])
                }
            }
            await capture("28-settings-notifications-note", style: styleName, in: directory, wait: 1.2) {
                model.push.debugSet(permission: .off, dismissedAt: .now, needsSystemSettings: true)
            }
            model.push.debugSet(permission: .notSet, dismissedAt: .now)
            await capture("12-instances", style: styleName, in: directory, wait: 1.2) { model.debugCommand = .settings([.instances]) }
            model.debugCommand = .settings(nil)
            await capture("13-routines", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .section(.routines) }
            await capture("14-search", style: styleName, in: directory, wait: 1.2) { model.debugCommand = .section(.search) }
            await capture("24-topic-chat", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .section(.topic("topic-trip")) }
            await capture("25-topic-blank", style: styleName, in: directory, wait: 1.2) { model.debugCommand = .section(.newTopic(UUID())) }
            await capture("29-topic-photo-long-reply", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-home")) }
            await capture("15-task-answered", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .route([.taskChat(chatId: "chat-login", title: "修复登录页样式")])
            }
            model.debugCommand = .route([])
            try? await Task.sleep(for: .seconds(0.6))
            await capture("16-chat-empty", style: styleName, in: directory, wait: 2) { model.openDemo(.empty) }
            await capture("17-chat-off", style: styleName, in: directory, wait: 2) { model.openDemo(.conciergeOff) }
            await capture("18-tasks-empty", style: styleName, in: directory, wait: 1.6) {
                model.openDemo(.empty)
                Task {
                    try? await Task.sleep(for: .seconds(0.8))
                    model.debugCommand = .tasks(true)
                }
            }
            model.debugCommand = .tasks(false)
            try? await Task.sleep(for: .seconds(0.6))
            model.dynamicTypeOverride = .xxLarge
            await capture("19-chat-xxl", style: styleName, in: directory, wait: 2) { model.openDemo() }
            model.dynamicTypeOverride = nil
            await capture("20-update-required", style: styleName, in: directory, wait: 2) { model.openDemo(.updateRequired) }
            await capture("21-update-updating", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.updating(target: DemoBackend.releasedVersion, since: .now))
            }
            await capture("31-update-starting", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.starting(current: "0.41.3", latest: DemoBackend.releasedVersion))
            }
            await capture("32-update-restarting", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.updating(target: DemoBackend.releasedVersion, since: .now), progress: .restarting)
            }
            await capture("33-update-almost-done", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.updating(target: DemoBackend.releasedVersion, since: .now), progress: .almostDone)
            }
            await capture("22-update-failed", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.failed(.timedOut(target: DemoBackend.releasedVersion)))
            }
            model.update.reset()
            await capture("23-chat-push-offer", style: styleName, in: directory, wait: 2) {
                model.push.debugSet(permission: .notSet)
                model.openDemo()
            }
            model.push.debugSet(permission: .notSet, dismissedAt: .now)
            model.debugSetPhase(.signedOut)
            try? await Task.sleep(for: .seconds(0.6))
        }
        FileManager.default.createFile(atPath: directory.appending(path: "DONE").path, contents: Data())
        exit(0)
    }

    /// Against a local Rome: send a real request, watch the Concierge start a
    /// task, and capture the chat, the task list and the task chat.
    private static func runLive(model: AppModel, directory: URL) async {
        let environment = ProcessInfo.processInfo.environment
        let prompt = environment["ROME_SNAPSHOT_PROMPT"].flatMap { $0.isEmpty ? nil : $0 } ?? "帮我开一个任务：写一首关于秋天的四行短诗，写好后告诉我。"
        window?.overrideUserInterfaceStyle = environment["ROME_SNAPSHOT_STYLE"] == "dark" ? .dark : .light
        await model.launch(skipSnapshot: true)
        try? await Task.sleep(for: .seconds(3))
        await capture("live-01-chat", style: "live", in: directory) {}
        if let workspace = model.workspace, prompt != "-" {
            _ = workspace.concierge.send(prompt)
            await capture("live-02-sent", style: "live", in: directory, wait: 1.0) {}
            await capture("live-03-typing", style: "live", in: directory, wait: 3) {}
            for _ in 0..<60 where workspace.concierge.running || workspace.tasks.tasks.isEmpty {
                try? await Task.sleep(for: .seconds(2))
            }
            try? await Task.sleep(for: .seconds(4))
            await capture("live-04-replied", style: "live", in: directory) {}
            await capture("live-05-tasks", style: "live", in: directory, wait: 2) { model.debugCommand = .tasks(true) }
            model.debugCommand = .tasks(false)
            try? await Task.sleep(for: .seconds(0.8))
            if let task = workspace.tasks.tasks.first(where: { $0.chat != nil }), let chat = task.chat {
                await capture("live-06-task", style: "live", in: directory, wait: 3) {
                    model.debugCommand = .route([.taskChat(chatId: chat.id, title: chat.name)])
                }
                for _ in 0..<45 where workspace.tasks.tone(forChat: chat.id) == .running {
                    try? await Task.sleep(for: .seconds(2))
                }
                await capture("live-07-task-done", style: "live", in: directory, wait: 3) {}
                model.debugCommand = .route([])
                try? await Task.sleep(for: .seconds(3))
                await capture("live-08-chat-after", style: "live", in: directory, wait: 2) {}
            }
        }
        FileManager.default.createFile(atPath: directory.appending(path: "DONE").path, contents: Data())
        exit(0)
    }

    private static var window: UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first
    }

    private static func sizeWindow() async {
        for _ in 0..<20 {
            if let scene = window?.windowScene {
                let size = CGSize(width: 393, height: 852)
                scene.sizeRestrictions?.minimumSize = size
                scene.sizeRestrictions?.maximumSize = size
                try? await Task.sleep(for: .seconds(1))
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    private static func capture(
        _ name: String,
        style: String,
        in directory: URL,
        wait: Double = 1.2,
        _ setUp: () -> Void
    ) async {
        guard only.isEmpty || only.contains(name) else { return }
        setUp()
        try? await Task.sleep(for: .seconds(wait))
        guard let window, let scene = window.windowScene else { return }
        let windows = scene.windows.filter { !$0.isHidden }.sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in
            for item in windows {
                item.drawHierarchy(in: item.frame.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY), afterScreenUpdates: true)
            }
            // A presented sheet is not always part of the window's own drawing.
            var presented = window.rootViewController?.presentedViewController
            while let controller = presented {
                if let container = controller.presentationController?.containerView {
                    container.drawHierarchy(in: container.convert(container.bounds, to: window), afterScreenUpdates: true)
                }
                presented = controller.presentedViewController
            }
        }
        try? image.pngData()?.write(to: directory.appending(path: "\(name)-\(style).png"))
    }
}
#endif
