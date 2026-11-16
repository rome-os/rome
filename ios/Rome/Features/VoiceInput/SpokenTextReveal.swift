import QuartzCore
import UIKit

/// Which spoken characters show, and since when, while voice input listens.
/// Characters appear at `rate` a second whatever pace the text arrives at, and
/// never more than `maxLag` behind it. Each fades in over `fade`.
struct SpokenTextReveal {
    static let rate: Double = 20
    /// One second of characters at `rate`.
    static let maxLag = 20
    static let fade: TimeInterval = 0.28

    /// Every character heard so far.
    private(set) var target: [Character] = []
    /// The characters showing, each with the time it appeared.
    private(set) var shown: [(character: Character, at: TimeInterval)] = []
    private var credit: Double = 0
    private var tickedAt: TimeInterval?
    /// Shows each character at once, with no fade.
    let instant: Bool

    init(instant: Bool = false) {
        self.instant = instant
    }

    var shownText: String { String(shown.map(\.character)) }

    /// Takes the text heard so far. A correction takes back the shown
    /// characters past the first that no longer matches; those before it keep
    /// their place and their fade.
    mutating func setTarget(_ text: String, now: TimeInterval) {
        // Caught up: the display link has stopped, so the time since the last
        // frame was a pause and banks no characters for the next words.
        if shown.count == target.count {
            tickedAt = now
            credit = 0
        }
        target = Array(text)
        var same = 0
        while same < shown.count, same < target.count, shown[same].character == target[same] { same += 1 }
        shown.removeLast(shown.count - same)
        if instant { reveal(upTo: target.count, at: -.infinity) }
        if shown.count == target.count { credit = 0 }
        tickedAt = tickedAt ?? now
    }

    /// Shows the characters due by `now`.
    mutating func advance(to now: TimeInterval) {
        let elapsed = max(0, now - (tickedAt ?? now))
        tickedAt = now
        guard shown.count < target.count else {
            credit = 0
            return
        }
        credit += elapsed * Self.rate
        let due = min(target.count, shown.count + Int(credit))
        credit -= Double(due - shown.count)
        reveal(upTo: max(due, target.count - Self.maxLag), at: now)
    }

    /// How opaque the shown character at `index` is at `now`, eased out.
    func opacity(at index: Int, now: TimeInterval) -> CGFloat {
        let progress = min(1, max(0, (now - shown[index].at) / Self.fade))
        let rest = 1 - progress
        return CGFloat(1 - rest * rest * rest)
    }

    /// Every character heard shows, and none is still fading.
    func settled(at now: TimeInterval) -> Bool {
        shown.count == target.count && (shown.last.map { now - $0.at >= Self.fade } ?? true)
    }

    private mutating func reveal(upTo count: Int, at time: TimeInterval) {
        while shown.count < count { shown.append((target[shown.count], time)) }
    }
}

/// Draws a `SpokenTextReveal` into the message field's view, between the text
/// before and after the cursor, once a frame until it settles.
@MainActor
final class SpokenTextRevealer {
    private weak var view: PastingTextView?
    private let before: String
    private let after: String
    private var reveal: SpokenTextReveal
    private var link: CADisplayLink?
    private let onDraw: (String) -> Void
    /// The field's own, read before any character is faded: once text is
    /// attributed, the view reports the first character's.
    private let font: UIFont
    private let color: UIColor

    /// `onDraw` gets the field's whole text each time it changes.
    init(view: PastingTextView, before: String, after: String, onDraw: @escaping (String) -> Void) {
        self.view = view
        self.before = before
        self.after = after
        self.onDraw = onDraw
        font = view.font ?? .preferredFont(forTextStyle: .body)
        color = view.textColor ?? .label
        reveal = SpokenTextReveal(instant: UIAccessibility.isReduceMotionEnabled)
    }

    /// The text heard, as it goes in at the cursor.
    func show(_ insertion: String) {
        reveal.setTarget(insertion, now: CACurrentMediaTime())
        draw()
        if link == nil, !reveal.settled(at: CACurrentMediaTime()) {
            let link = CADisplayLink(target: self, selector: #selector(frame))
            // A 280 ms fade reads smoothly at 60 Hz; ProMotion's 120 Hz only costs layout.
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    /// Stops drawing and shows every word heard, in plain text, so typing
    /// after it is not faded.
    func stop() {
        link?.invalidate()
        link = nil
        guard let view else { return }
        let words = before + String(reveal.target) + after
        view.text = words
        view.font = font
        view.textColor = color
        view.typingAttributes = [.font: font, .foregroundColor: color]
        onDraw(words)
    }

    @objc private func frame() {
        let now = CACurrentMediaTime()
        reveal.advance(to: now)
        draw()
        if reveal.settled(at: now) {
            link?.invalidate()
            link = nil
        }
    }

    private func draw() {
        guard let view else { return }
        let now = CACurrentMediaTime()
        let shownText = reveal.shownText
        let text = NSMutableAttributedString(string: before + shownText + after, attributes: [.font: font, .foregroundColor: color])
        // Only the newest few characters are still fading: they appear in
        // order, so they are a run at the end of what shows, and each gets
        // its own shade while the rest keep the text color.
        var end = (before as NSString).length + (shownText as NSString).length
        for index in reveal.shown.indices.reversed() {
            let opacity = reveal.opacity(at: index, now: now)
            guard opacity < 1 else { break }
            let length = (String(reveal.shown[index].character) as NSString).length
            end -= length
            text.addAttribute(.foregroundColor, value: color.withAlphaComponent(color.cgColor.alpha * opacity), range: NSRange(location: end, length: length))
        }
        view.attributedText = text
        onDraw(text.string)
    }
}
