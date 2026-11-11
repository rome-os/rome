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
    /// The photo viewer on a demo image, or closed.
    case photoViewer(Bool)
    /// The Apps page's "New app" sheet, or closed.
    case appIdeas(Bool)
    /// A page of the instance in its sheet; nil closes it.
    case page(URL?)
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
            // The header: the mascot with its name tag, and the status in a
            // capsule of its own, in each state.
            if let workspace = model.workspace {
                let main = workspace.mainChatServerID ?? conciergeChatID
                await capture("57-header-idle", style: styleName, in: directory, wait: 0.8) { workspace.topics.setActivity(nil, for: main) }
                await capture("57b-header-working", style: styleName, in: directory, wait: 0.8) { workspace.topics.setActivity(.working, for: main) }
                await capture("57c-header-long-task", style: styleName, in: directory, wait: 0.8) {
                    workspace.topics.setActivity(.tasks(title: "整理本周所有会议纪要，并发给团队每个人确认", more: 2), for: main)
                }
                await capture("57d-header-long-name", style: styleName, in: directory, wait: 0.8) {
                    workspace.debugSetAgentName("米洛的超级长名字小管家助手")
                    workspace.topics.setActivity(.working, for: main)
                }
                workspace.debugSetAgentName("Milo")
                // A chat thread open over a busy chat: its header carries the status too.
                await capture("57e-header-thread-open", style: styleName, in: directory, wait: 1.5) {
                    workspace.topics.setActivity(.tasks(title: "Mac app 右上角按钮点不到", more: 1), for: main)
                    if let id = workspace.concierge.messages.last(where: { !$0.isUser })?.id { workspace.concierge.openThread(at: id) }
                }
                workspace.concierge.closeThread()
                workspace.topics.setActivity(nil, for: main)
            }
            // Reply on an Agent message in no chat thread: quoted above the composer.
            await capture("04b-chat-quote", style: styleName, in: directory, wait: 1) {
                guard let chat = model.workspace?.concierge,
                      let said = chat.messages.last(where: { message in
                          !message.isUser && message.parts.contains { if case .text = $0 { true } else { false } }
                      })
                else { return }
                chat.reply(to: said.id)
            }
            model.workspace?.concierge.cancelQuote()
            // The header's status line in each state, then back to the name alone.
            let states: [(String, ConciergeActivity)] = [
                ("working", .working), ("tool", .tool(.searchingWeb)), ("tasks", .tasks(title: "整理本周会议纪要", more: 1)),
                ("needs-you", .needsYou), ("idle", .idle),
            ]
            for (name, state) in states {
                await capture("60-status-\(name)", style: styleName, in: directory, wait: 0.8) {
                    model.workspace?.topics.setActivity(state, for: conciergeChatID)
                }
            }
            model.workspace?.topics.setActivity(nil, for: conciergeChatID)
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
            try? await Task.sleep(for: .seconds(0.6))
            await capture("13-node-requests", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .settings([.requests]) }
            model.debugCommand = .settings(nil)
            try? await Task.sleep(for: .seconds(0.6))
            // The Apple Health page is longer than a screen: its top, the data flow, and its end.
            model.debugHealthScroll = nil
            await capture("14-health-access", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .settings([.health]) }
            await capture("15-health-access-data", style: styleName, in: directory, wait: 1) { model.debugHealthScroll = "where" }
            await capture("16-health-access-end", style: styleName, in: directory, wait: 1) { model.debugHealthScroll = "end" }
            model.debugHealthScroll = nil
            model.debugCommand = .settings(nil)
            // A second command in the same pass would hide this one from the shell.
            try? await Task.sleep(for: .seconds(0.6))
            // On Mac Catalyst a pushed task chat does not pop for these runs
            // (it does on a phone): open the demo afresh, with nothing pushed.
            model.openDemo()
            try? await Task.sleep(for: .seconds(2))
            await capture("14-search", style: styleName, in: directory, wait: 1.2) { model.debugCommand = .section(.search) }
            await capture("24-topic-chat", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .section(.topic("topic-trip")) }
            // Connect cards in each state, and a question with defaults and descriptions.
            TranscriptStore.previewPhases = ["notion": .connecting, "linear": .failed(String(localized: "Sign-in timed out"))]
            await capture("43-connect-cards", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-mail")) }
            TranscriptStore.previewPhases = [:]
            await capture("44-question-defaults", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-mail-setup")) }
            // Chat threads: the replies lines, then one thread open over its chat.
            await capture("50-topic-threads", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-trip")) }
            // Share mode on the last two turns, then the chat's links.
            await capture("61-share-select", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .section(.topic("topic-trip"))
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    guard let share = model.workspace?.topicStore("topic-trip").share, let order = share.turns?.order else { return }
                    share.begin(turn: order.last)
                    if order.count > 1 { share.toggle(order[order.count - 2]) }
                }
            }
            await capture("62-shared-links", style: styleName, in: directory, wait: 1.5) {
                guard let share = model.workspace?.topicStore("topic-trip").share else { return }
                share.cancel()
                share.openLinks()
            }
            await capture("63-shared-links-empty", style: styleName, in: directory, wait: 2) {
                model.workspace?.topicStore("topic-trip").share.showsLinks = false
                model.debugCommand = .section(.chat)
                model.workspace?.concierge.share.openLinks()
            }
            // A task chat: its brief, a card, starts the first turn.
            await capture("64-share-task", style: styleName, in: directory, wait: 2.5) {
                model.workspace?.concierge.share.showsLinks = false
                model.debugCommand = .route([.taskChat(chatId: "chat-login", title: "修复登录页样式")])
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    guard let share = model.workspace?.taskStore("chat-login").share, let order = share.turns?.order else { return }
                    share.begin(turn: order.first)
                }
            }
            model.workspace?.taskStore("chat-login").share.cancel()
            model.debugCommand = .route([])
            if let workspace = model.workspace {
                workspace.topicStore("topic-trip").share.cancel()
                workspace.topicStore("topic-trip").share.showsLinks = false
                workspace.concierge.share.showsLinks = false
            }
            // A long chat thread: its root carries the replies line.
            await capture("53-topic-long-thread", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-books")) }
            // A long topic name: cut at the end inside the header's pill.
            await capture("52-topic-long-name", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-home")) }
            model.debugCommand = .section(.topic("topic-trip"))
            try? await Task.sleep(for: .seconds(1.5))
            await capture("51-thread-open", style: styleName, in: directory, wait: 1.5) {
                model.workspace?.topicStore("topic-trip").openThread(at: "k1")
            }
            model.workspace?.topicStore("topic-trip").closeThread()
            try? await Task.sleep(for: .seconds(0.4))
            // A thread taller than the screen, opened near its foot: the
            // header above the rows, the last answer just above the composer.
            model.debugCommand = .section(.topic("topic-books"))
            try? await Task.sleep(for: .seconds(1.5))
            await capture("54-long-thread-open", style: styleName, in: directory, wait: 1.5) {
                model.workspace?.topicStore("topic-books").openThread(at: "b23")
            }
            model.workspace?.topicStore("topic-books").closeThread()
            try? await Task.sleep(for: .seconds(0.4))
            // The same long thread while the chat runs a task: rows scroll under the status.
            await capture("54b-long-thread-busy", style: styleName, in: directory, wait: 1.5) {
                model.workspace?.topics.setActivity(.tasks(title: "Mac app 右上角按钮点不到", more: 1), for: "topic-books")
                model.workspace?.topicStore("topic-books").openThread(at: "b23")
            }
            model.workspace?.topicStore("topic-books").closeThread()
            model.workspace?.topics.setActivity(nil, for: "topic-books")
            try? await Task.sleep(for: .seconds(0.4))
            // Routine cards with their state, and the rows for cards only the web draws.
            await capture("48-routine-cards", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-routine")) }
            // Markdown tables: a narrow one, and a wide one that scrolls inside its bubble.
            await capture("56-markdown-tables", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-table")) }
            await capture("57-widget-ui-card", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-meals")) }
            // The drawer over a topic chat: its row selected.
            await capture("05b-drawer-topic", style: styleName, in: directory) { model.debugCommand = .drawer(true) }
            model.debugCommand = .drawer(false)
            try? await Task.sleep(for: .seconds(0.8))
            await capture("25-topic-blank", style: styleName, in: directory, wait: 1.2) { model.debugCommand = .section(.newTopic(UUID())) }
            await capture("29-topic-photo-long-reply", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-home")) }
            // The same reply unfolded, its chevron pointing up.
            AgentBubble.startsExpanded = true
            model.debugCommand = .section(.chat)
            try? await Task.sleep(for: .seconds(0.6))
            await capture("29b-topic-long-reply-unfolded", style: styleName, in: directory, wait: 2) { model.debugCommand = .section(.topic("topic-home")) }
            AgentBubble.startsExpanded = false
            model.debugCommand = .section(.chat)
            try? await Task.sleep(for: .seconds(0.6))
            model.debugCommand = .section(.topic("topic-home"))
            try? await Task.sleep(for: .seconds(0.6))
            await capture("34-photo-viewer", style: styleName, in: directory, wait: 2) { model.debugCommand = .photoViewer(true) }
            model.debugCommand = .photoViewer(false)
            try? await Task.sleep(for: .seconds(0.4))
            await capture("15-task-answered", style: styleName, in: directory, wait: 2) {
                model.debugCommand = .route([.taskChat(chatId: "chat-login", title: "修复登录页样式")])
            }
            model.debugCommand = .route([])
            try? await Task.sleep(for: .seconds(0.6))
            // No apps opened from this phone yet: one untitled group.
            UserDefaults.standard.removeObject(forKey: "recentApps.me.romeos.cc")
            await capture("37a-apps-no-recent", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .section(.apps) }
            model.debugCommand = .section(.chat)
            try? await Task.sleep(for: .seconds(0.4))
            for id in ["habits", "reading", "packing"] { RecentApps(host: "me.romeos.cc").record(id) }
            await capture("37-apps", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .section(.apps) }
            await capture("39-app-open", style: styleName, in: directory, wait: 2.5) {
                model.debugCommand = .route([.app(InstalledApp(id: "habits", displayName: "习惯打卡", fullHref: "/full/apps/habits", origin: "local"))])
            }
            model.debugCommand = .route([])
            try? await Task.sleep(for: .seconds(0.6))
            // A dashboard page a card opened, in the app's web view, as a sheet.
            await capture("49-dashboard-page", style: styleName, in: directory, wait: 2.5) {
                model.debugCommand = .page(URL(string: "https://me.romeos.cc/routines")!)
            }
            model.debugCommand = .page(nil)
            try? await Task.sleep(for: .seconds(0.6))
            await capture("37b-apps-new", style: styleName, in: directory, wait: 1.2) {
                model.debugCommand = .section(.apps)
                Task {
                    try? await Task.sleep(for: .seconds(0.6))
                    model.debugCommand = .appIdeas(true)
                }
            }
            model.debugCommand = .appIdeas(false)
            try? await Task.sleep(for: .seconds(0.4))
            await capture("40-apps-many", style: styleName, in: directory, wait: 2) {
                model.openDemo(.manyApps)
                model.debugCommand = nil
                Task {
                    try? await Task.sleep(for: .seconds(0.6))
                    model.debugCommand = .section(.apps)
                }
            }
            // Large text: names cut, nothing overlaps; three columns at accessibility sizes.
            for (name, size) in [("41-apps-many-ax3", DynamicTypeSize.accessibility3), ("42-apps-many-xxxl", .xxxLarge)] {
                model.dynamicTypeOverride = size
                await capture(name, style: styleName, in: directory, wait: 2) {
                    model.openDemo(.manyApps)
                    model.debugCommand = nil
                    Task {
                        try? await Task.sleep(for: .seconds(0.6))
                        model.debugCommand = .section(.apps)
                    }
                }
            }
            model.dynamicTypeOverride = nil
            // A dashboard visitor of the shared Rome: the drawer footer, Settings and the instance list.
            model.openDemo(.visitor)
            try? await Task.sleep(for: .seconds(2))
            await capture("45-visitor-drawer", style: styleName, in: directory) { model.debugCommand = .drawer(true) }
            model.debugCommand = .drawer(false)
            try? await Task.sleep(for: .seconds(0.8))
            await capture("46-visitor-settings", style: styleName, in: directory, wait: 1.5) { model.debugCommand = .settings([]) }
            await capture("47-visitor-instances", style: styleName, in: directory, wait: 1.2) { model.debugCommand = .settings([.instances]) }
            model.debugCommand = .settings(nil)
            try? await Task.sleep(for: .seconds(0.6))
            await capture("16-chat-empty", style: styleName, in: directory, wait: 2) { model.openDemo(.empty) }
            await capture("38-apps-empty", style: styleName, in: directory, wait: 2) {
                model.openDemo(.empty)
                model.debugCommand = nil
                Task {
                    try? await Task.sleep(for: .seconds(0.6))
                    model.debugCommand = .section(.apps)
                }
            }
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
            // Accessibility text: the sign-in and update pages scroll above their buttons.
            model.dynamicTypeOverride = .accessibility3
            await capture("35-login-ax3", style: styleName, in: directory, wait: 1) { model.debugSetPhase(.signedOut) }
            await capture("36-update-ax3", style: styleName, in: directory, wait: 2) { model.openDemo(.updateRequired) }
            model.dynamicTypeOverride = nil
            await capture("20-update-required", style: styleName, in: directory, wait: 2) { model.openDemo(.updateRequired) }
            // Behind but new enough: the pill above the composer, the drawer's
            // line, and the page it opens; then the pill after an upgrade.
            await capture("48-update-pill", style: styleName, in: directory, wait: 4) { model.openDemo(.updateOffered) }
            await capture("49-update-drawer", style: styleName, in: directory) { model.debugCommand = .drawer(true) }
            model.debugCommand = .drawer(false)
            try? await Task.sleep(for: .seconds(0.8))
            await capture("50-update-offered-page", style: styleName, in: directory, wait: 1.2) { model.update.openPage() }
            model.update.closePage()
            await capture("48b-update-done", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.upToDate)
                model.update.debugShowUpdated(DemoBackend.releasedVersion)
            }
            await capture("21-update-updating", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.updating(target: DemoBackend.releasedVersion, since: .now))
            }
            await capture("31-update-starting", style: styleName, in: directory, wait: 1) {
                model.update.debugShow(.starting(current: DemoBackend.tooOldVersion, latest: DemoBackend.releasedVersion))
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
