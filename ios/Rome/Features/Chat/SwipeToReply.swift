import SwiftUI
import UIKit

/// How a swipe to Reply follows the finger: one to one up to the threshold,
/// then less and less. Past the threshold, letting go replies.
enum SwipeTravel {
    /// The finger's travel to the right that replies on release.
    static let threshold: CGFloat = 56
    /// How much further than the threshold the row can go, at most.
    static let stretch: CGFloat = 44

    /// How far the row moves for the finger's travel.
    static func offset(_ travel: CGFloat) -> CGFloat {
        guard travel > threshold else { return max(0, travel) }
        let past = travel - threshold
        return threshold + stretch * (1 - 1 / (past / stretch * 0.5 + 1))
    }

    /// Letting go here replies.
    static func armed(_ travel: CGFloat) -> Bool {
        travel >= threshold
    }

    /// Whether a drag that is about to start, by its velocity, is a swipe: to
    /// the right, and mostly sideways, so a scroll never becomes one.
    static func starts(_ move: CGPoint) -> Bool {
        move.x > 0 && move.x > 2 * abs(move.y)
    }
}

/// A swipe to the right on a message that takes a Reply, as in Messages or
/// WhatsApp: the row follows the finger, a reply arrow comes in behind it,
/// and crossing the threshold taps once. Letting go past it replies, the
/// same as Reply in the long-press menu. The list's own pan waits for the
/// swipe to fail, which it does on the first movement that is not one.
///
/// The row moves by its cell's transform, so a swipe runs no SwiftUI.
@MainActor
final class SwipeToReply: NSObject, UIGestureRecognizerDelegate {
    /// The message, and its row, that a swipe on an item replies to; nil
    /// where none can be replied to.
    var target: (IndexPath) -> (message: String, row: String)? = { _ in nil }
    var onReply: (_ message: String, _ row: String) -> Void = { _, _ in }

    private weak var list: UICollectionView?
    private let pan = UIPanGestureRecognizer()
    private let haptic = UIImpactFeedbackGenerator(style: .medium)
    /// The swipe under way: its item and the cell it moves.
    private var swiping: (message: String, row: String, cell: UICollectionViewCell)?
    private var arrow: UIView?
    private var armed = false

    func attach(to list: UICollectionView) {
        self.list = list
        pan.addTarget(self, action: #selector(moved(_:)))
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        list.addGestureRecognizer(pan)
        list.panGestureRecognizer.require(toFail: pan)
    }

    // MARK: UIGestureRecognizerDelegate

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // The translation can still be zero here; the velocity is not.
        guard let list, SwipeTravel.starts(pan.velocity(in: list)) else { return false }
        let translation = pan.translation(in: list)
        let location = pan.location(in: list)
        let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
        guard let indexPath = list.indexPathForItem(at: start), target(indexPath) != nil else { return false }
        // A table or a code block that scrolls sideways keeps the drag.
        return !Self.scrollsSideways(list.hitTest(start, with: nil), in: list)
    }

    /// A scroll view inside the list waits for the swipe to fail, so one that
    /// cannot scroll sideways does not bounce instead.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        guard let list, let scrollView = other.view as? UIScrollView, scrollView !== list else { return false }
        return other is UIPanGestureRecognizer && scrollView.isDescendant(of: list)
    }

    /// Whether `view` sits in a scroll view inside the list with more to show sideways.
    private static func scrollsSideways(_ view: UIView?, in list: UICollectionView) -> Bool {
        var view = view
        while let current = view, current !== list {
            if let scrollView = current as? UIScrollView, scrollView.contentSize.width > scrollView.bounds.width + 1 {
                return true
            }
            view = current.superview
        }
        return false
    }

    // MARK: The swipe

    @objc private func moved(_ pan: UIPanGestureRecognizer) {
        guard let list else { return }
        switch pan.state {
        case .began:
            let translation = pan.translation(in: list)
            let location = pan.location(in: list)
            let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
            guard let indexPath = list.indexPathForItem(at: start), let item = target(indexPath),
                  let cell = list.cellForItem(at: indexPath) else {
                // Cancels it.
                pan.isEnabled = false
                pan.isEnabled = true
                return
            }
            swiping = (item.message, item.row, cell)
            armed = false
            haptic.prepare()
            let arrow = Self.makeArrow()
            cell.insertSubview(arrow, belowSubview: cell.contentView)
            self.arrow = arrow
            follow(pan.translation(in: list).x)
        case .changed:
            follow(pan.translation(in: list).x)
        case .ended:
            if armed, let swiping { onReply(swiping.message, swiping.row) }
            settle()
        default:
            settle()
        }
    }

    /// The row and the arrow where the finger's travel puts them.
    private func follow(_ travel: CGFloat) {
        guard let swiping, let arrow, let list else { return }
        let cell = swiping.cell
        let offset = SwipeTravel.offset(travel)
        cell.contentView.transform = CGAffineTransform(translationX: offset, y: 0)
        let progress = min(1, offset / SwipeTravel.threshold)
        // In the gap the row leaves at the start of its column.
        let column = (cell.bounds.width - min(cell.bounds.width, Metrics.readableWidth)) / 2
        let visible = list.convert(list.bounds.inset(by: list.contentInset), to: cell).intersection(cell.bounds)
        let middle = visible.isNull ? cell.bounds.midY : min(max(cell.bounds.midY, visible.minY + 20), visible.maxY - 20)
        arrow.center = CGPoint(x: column + 8 + offset / 2, y: middle)
        arrow.alpha = progress
        let scale = 0.6 + 0.4 * progress
        arrow.transform = CGAffineTransform(scaleX: scale, y: scale)
        let nowArmed = SwipeTravel.armed(travel)
        guard nowArmed != armed else { return }
        armed = nowArmed
        guard nowArmed else { return }
        haptic.impactOccurred()
        haptic.prepare()
        if !UIAccessibility.isReduceMotionEnabled {
            // A small pop as it arms.
            let pop = CAKeyframeAnimation(keyPath: "transform.scale")
            pop.values = [1, 1.2, 1]
            pop.duration = 0.25
            arrow.layer.add(pop, forKey: "pop")
        }
    }

    /// The row springs back and the arrow goes.
    private func settle() {
        guard let swiping else { return }
        self.swiping = nil
        armed = false
        let arrow = self.arrow
        self.arrow = nil
        UIView.animate(springDuration: 0.3, bounce: 0) {
            swiping.cell.contentView.transform = .identity
            arrow?.alpha = 0
        } completion: { _ in
            arrow?.removeFromSuperview()
        }
    }

    private static func makeArrow() -> UIView {
        let size: CGFloat = 30
        let circle = UIView(frame: CGRect(x: 0, y: 0, width: size, height: size))
        circle.backgroundColor = UIColor(Palette.fill)
        circle.layer.cornerRadius = size / 2
        circle.isUserInteractionEnabled = false
        circle.alpha = 0
        let glyph = UIImageView(image: UIImage(
            systemName: "arrowshape.turn.up.left.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        ))
        glyph.tintColor = UIColor(Palette.sub)
        glyph.center = CGPoint(x: size / 2, y: size / 2)
        circle.addSubview(glyph)
        return circle
    }
}
