import SwiftUI

/// An action of the shell that views far below it call (a tapped link, "See
/// usage"). The environment holds this object, not a closure: the shell keeps
/// `run` current, so a shell update never changes what the environment holds
/// and no view that reads it is drawn again for it.
@MainActor
final class ShellAction<Input, Output> {
    var run: (Input) -> Output
    private let idle: (Input) -> Output

    init(_ run: @escaping (Input) -> Output) {
        self.run = run
        idle = run
    }

    /// Back to what it did before the shell set it.
    func reset() { run = idle }
}

/// The shell's actions for one workspace. The shell sets what they run, and
/// those closures hold the shell, which holds the workspace: the workspace
/// owns them and empties them when it stops, so a closed workspace is freed
/// however its shell left the screen (under the Agent page's cover too).
@MainActor
final class ShellActions {
    let linkOpener = ShellAction<URL, OpenURLAction.Result> { _ in .systemAction }
    let openUsage = ShellAction<Void, Void> { _ in }
    /// The same, for the Agent page's cover, which closes before Settings opens.
    let openUsageFromCover = ShellAction<Void, Void> { _ in }
    /// The main Chat's header: the drawer or the sidebar, and the Agent page.
    let toggleNavigation = ShellAction<Void, Void> { _ in }
    let openAgent = ShellAction<Void, Void> { _ in }
    /// A task chat opened from the main Chat, pushed over it.
    let openTaskChat = ShellAction<(chatId: String, title: String), Void> { _ in }

    func reset() {
        linkOpener.reset()
        openUsage.reset()
        openUsageFromCover.reset()
        toggleNavigation.reset()
        openAgent.reset()
        openTaskChat.reset()
    }
}
