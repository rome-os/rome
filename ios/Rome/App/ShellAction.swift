import Foundation

/// An action of the shell that views far below it call (a tapped link, "See
/// usage"). The environment holds this object, not a closure: the shell keeps
/// `run` current, so a shell update never changes what the environment holds
/// and no view that reads it is drawn again for it.
@MainActor
final class ShellAction<Input, Output> {
    var run: (Input) -> Output

    init(_ run: @escaping (Input) -> Output) {
        self.run = run
    }
}
