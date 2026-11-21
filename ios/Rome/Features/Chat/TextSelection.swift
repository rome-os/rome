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
    /// The message in select mode: its row, the text it had when picked,
    /// and where the long press that opened its menu was, in the window.
    struct Target: Equatable {
        let row: String
        let text: String
        var point: CGPoint? = nil
    }

    private(set) var target: Target?

    /// The last touch down on the transcript, in the window, and when: the
    /// long press that opened a bubble's menu, read when Select text is
    /// picked. Not observed: a touch redraws nothing.
    @ObservationIgnored private var lastTouch: (point: CGPoint, at: Date)?
    /// Older than this, a touch is not the press that opened the menu (Select
    /// text picked with VoiceOver, say), and select mode opens on the first
    /// paragraph.
    static let touchLifetime: TimeInterval = 30

    func touchedDown(at point: CGPoint, now: Date = .now) {
        lastTouch = (point, now)
    }

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
    func begin(row: String, text: String, now: Date = .now) {
        let press = lastTouch.flatMap { now.timeIntervalSince($0.at) <= Self.touchLifetime ? $0.point : nil }
        target = Target(row: row, text: text, point: press)
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
