import Observation
import SwiftUI
import UIKit

/// Which message of a transcript is in select mode, if any: the one picked
/// with Select text in its bubble's menu, whose text is drawn selectable in
/// place (`SelectableTextView`) until something ends it. One per transcript,
/// kept by its store.
///
/// Select mode ends on a tap on the transcript outside the message, a scroll,
/// the composer taking focus, Select text on another message, a tapped link,
/// or the message's text changing (it streamed on, or was edited).
@MainActor
@Observable
final class TextSelection {
    /// The message in select mode: its row, and the text it had when picked.
    struct Target: Equatable {
        let row: String
        let text: String
    }

    private(set) var target: Target?

    @ObservationIgnored nonisolated(unsafe) private var editing: NSObjectProtocol?

    init() {
        // The composer, or any text view, taking focus ends it. UIKit posts
        // it on the main thread, so it is read there at once.
        editing = NotificationCenter.default.addObserver(
            forName: UITextView.textDidBeginEditingNotification, object: nil, queue: nil
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    deinit {
        if let editing { NotificationCenter.default.removeObserver(editing) }
    }

    var isActive: Bool { target != nil }

    /// Puts the message of `row` in select mode; any other leaves it.
    func begin(row: String, text: String) {
        target = Target(row: row, text: text)
    }

    func end() {
        if target != nil { target = nil }
    }

    /// Whether the message of `row`, now reading `text`, is in select mode.
    /// A message whose text changed since it was picked is not.
    func isSelecting(row: String?, text: String) -> Bool {
        guard let row, let target else { return false }
        return target.row == row && target.text == text
    }

    /// The message of `row` now reads `text`: select mode ends if it was this
    /// message's and the text is not the one picked.
    func messageChanged(row: String?, text: String) {
        guard let row, let target, target.row == row, target.text != text else { return }
        self.target = nil
    }
}

extension EnvironmentValues {
    /// The transcript's select mode; nil where a bubble's text cannot be selected.
    @Entry var textSelection: TextSelection? = nil
}
