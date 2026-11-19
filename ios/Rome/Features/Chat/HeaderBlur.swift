import SwiftUI
import UIKit

/// A blur that is strongest at its top edge and gone at its bottom edge,
/// built from public API: blur bands of growing strength toward the top,
/// each fading out downward, so their sum thins out smoothly. Rows show
/// through it untinted. It takes no touches.
struct HeaderBlur: UIViewRepresentable {
    func makeUIView(context: Context) -> HeaderBlurView { HeaderBlurView() }
    func updateUIView(_ view: HeaderBlurView, context: Context) {}

    static func dismantleUIView(_ view: HeaderBlurView, coordinator: ()) {
        view.stopAnimators()
    }
}

final class HeaderBlurView: UIView {
    /// Each band: how far down it reaches (a share of the height) and how
    /// much of the full blur it holds. Bands overlap at the top, so the blur
    /// there is their sum; the lowest one alone reaches the bottom.
    private static let bands: [(reach: CGFloat, strength: CGFloat)] = [
        (1.0, 0.07), (0.78, 0.09), (0.56, 0.12), (0.36, 0.16),
    ]
    /// Dark's strengths, a step weaker: dim text on a black page blurs away
    /// sooner, and past these the lines under the clock are lost.
    private static let darkStrengths: [CGFloat] = [0.05, 0.07, 0.09, 0.13]

    private var views: [UIVisualEffectView] = []
    private var masks: [CAGradientLayer] = []
    /// The full blur, held part of the way by a paused animator: the public
    /// way to get a blur weaker than `UIBlurEffect`'s own.
    private var animators: [UIViewPropertyAnimator] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        for band in Self.bands {
            let view = UIVisualEffectView(effect: nil)
            let mask = CAGradientLayer()
            // Whole down to two thirds of its reach, then fading out.
            mask.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
            mask.locations = [0, NSNumber(value: Double(band.reach * 0.66)), NSNumber(value: Double(band.reach))]
            view.layer.mask = mask
            addSubview(view)
            views.append(view)
            masks.append(mask)
        }
        // A paused animator loses its effect when the app goes to the
        // background; it is set up again on return.
        NotificationCenter.default.addObserver(self, selector: #selector(invalidate), name: UIApplication.willEnterForegroundNotification, object: nil)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: HeaderBlurView, _) in view.invalidate() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// The size the animators were last set up at; nil when they need setting
    /// up again. Set up before a layout in a window, they show the full blur
    /// instead of the part they hold, so only `layoutSubviews` sets them up.
    private var builtSize: CGSize?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stopAnimators() }
        invalidate()
    }

    @objc private func invalidate() {
        builtSize = nil
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (view, mask) in zip(views, masks) {
            view.frame = bounds
            mask.frame = bounds
        }
        CATransaction.commit()
        if window != nil, bounds.size != .zero, bounds.size != builtSize {
            builtSize = bounds.size
            rebuild()
        }
    }

    private func rebuild() {
        stopAnimators()
        // Dark takes the least tinted blur: the regular one's dark tint
        // sinks the rows into the black page.
        let dark = traitCollection.userInterfaceStyle == .dark
        for (index, band) in Self.bands.enumerated() {
            let view = views[index]
            view.effect = nil
            let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) {
                view.effect = UIBlurEffect(style: dark ? .systemUltraThinMaterial : .regular)
            }
            animator.pausesOnCompletion = true
            animator.fractionComplete = dark ? Self.darkStrengths[index] : band.strength
            animators.append(animator)
        }
    }

    /// Stops the animators, which a paused animator needs before it is
    /// released. Leaving the window stops them; so does SwiftUI's teardown.
    func stopAnimators() {
        for animator in animators {
            animator.stopAnimation(true)
        }
        animators = []
    }
}
