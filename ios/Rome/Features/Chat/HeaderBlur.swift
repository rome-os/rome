import OSLog
import SwiftUI
import UIKit

private let headerBlurLog = Logger(subsystem: "cc.romeos.mobile", category: "HeaderBlur")

/// Behind a chat's header, the main Chat's and a topic chat's: rows show
/// through it blurred under the status bar, lightly blurred at the header's
/// buttons, and sharp below them, so the clock and the buttons stay legible
/// over any row. The strip keeps the page's colour; only the rows blur.
///
/// The list is a UICollectionView, and neither SwiftUI's scroll edge effect
/// nor UIKit's `topEdgeEffect` with a `UIScrollEdgeElementContainerInteraction`
/// band draws on it inside this hosting view.
struct ChatHeaderBlur: View {
    /// How far below the header's frame the blur turns clear: negative ends
    /// it at the buttons' lower edge, above the name tag.
    let reach: CGFloat
    @Environment(\.pageBackground) private var page
    @Environment(\.colorScheme) private var colorScheme

    /// The reach for a header whose status capsule hangs below its row or not.
    static func reach(statusShows: Bool, _ dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        // The row is 4 pt of padding, the identity's resting height with the
        // 44 pt buttons centred on it, and 4 pt more.
        let belowButtons = ChatIdentity.restingHeight(for: dynamicTypeSize) / 2 - 18
        return (statusShows ? ChatIdentity.statusHeight(for: dynamicTypeSize) : 0) - belowButtons
    }

    /// Experiment: UI tests that launch with `-RomeUITestsNoHeaderBlur YES`
    /// leave out the blur and its paused animators, to see whether they keep
    /// XCUITest from ever finding the app idle. Debug builds only.
    static let offForUITests: Bool = {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "RomeUITestsNoHeaderBlur")
        #else
        return false
        #endif
    }()

    var body: some View {
        ZStack {
            if !Self.offForUITests {
                HeaderBlur()
            }
            // A faint wash of the page under the clock only, so it reads over
            // any row. Dark has none: the black page would sink the blurred rows.
            // Eased, as the bands are, so its end shows no line.
            LinearGradient(stops: HeaderBlurView.easedFade(from: 0, to: 0.4).map {
                .init(color: page.opacity(colorScheme == .dark ? 0 : 0.3 * $0.alpha), location: $0.at)
            }, startPoint: .top, endPoint: .bottom)
        }
        .padding(.bottom, -reach)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

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
            // Whole down to 60% of its reach, then fading out on an eased
            // curve: a straight ramp leaves a visible seam where it ends.
            let fade = Self.easedFade(from: band.reach * 0.6, to: band.reach)
            mask.colors = [UIColor.black.cgColor] + fade.map { UIColor.black.withAlphaComponent($0.alpha).cgColor }
            mask.locations = [0] + fade.map { NSNumber(value: Double($0.at)) }
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

    /// Stops of a fade from whole at `start` to clear at `end` on a
    /// smoothstep curve, which meets both ends flat, so neither shows as an
    /// edge.
    static func easedFade(from start: CGFloat, to end: CGFloat, steps: Int = 8) -> [(at: CGFloat, alpha: CGFloat)] {
        (0...steps).map { step in
            let t = CGFloat(step) / CGFloat(steps)
            return (start + (end - start) * t, 1 - t * t * (3 - 2 * t))
        }
    }

    /// The size the animators were last set up at; nil when they need setting
    /// up again. Set up before a layout in a window, they show the full blur
    /// instead of the part they hold, so only `layoutSubviews` sets them up.
    private var builtSize: CGSize?

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
            // Paused animations set up while a page slides over or off this
            // one (a task chat closing) are dropped, and the bands would show
            // the full blur: set them up once it has settled.
            if let coordinator = owningController?.transitionCoordinator {
                coordinator.animate(alongsideTransition: nil) { [weak self] (_: UIViewControllerTransitionCoordinatorContext) in self?.setNeedsLayout() }
                return
            }
            builtSize = bounds.size
            rebuild()
        }
    }

    private var owningController: UIViewController? {
        sequence(first: self as UIResponder, next: { $0.next }).first { $0 is UIViewController } as? UIViewController
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
            Self.keepBlurOnly(view)
        }
    }

    /// Keeps the material's blur and drops the rest of its look: light's
    /// regular blur lays a white wash over the rows, and dark's material maps
    /// luminance, which lifted the black page to a grey. Each band held a
    /// different share of that, so the strip read lighter than the page and
    /// the bands' edges showed as a line. With the blur alone the strip is
    /// the page's own colour and only the rows under it blur. The pieces are
    /// matched by kind and filter name; a layout without them keeps its
    /// look, as before.
    private static func keepBlurOnly(_ view: UIVisualEffectView) {
        var matched = false
        for subview in view.subviews where subview !== view.contentView {
            if let filters = subview.layer.filters, !filters.isEmpty {
                // The backdrop: the blur, and the colour filters beside it.
                let blur = filters.filter { String(describing: $0).contains("gaussianBlur") }
                if !blur.isEmpty { matched = true }
                if !blur.isEmpty, blur.count < filters.count { subview.layer.filters = blur }
            } else if !String(describing: type(of: subview)).contains("Backdrop") {
                // The wash over the blur.
                subview.isHidden = true
            }
        }
        #if DEBUG
        // A UIKit that lays the effect out otherwise brings the tint and its
        // seam back with nothing failing: say so where a snapshot run looks.
        if !matched { headerBlurLog.error("header blur kept its tint: no backdrop blur filter found") }
        #endif
    }

    /// Stops the animators, which a paused animator needs before it is
    /// released. SwiftUI's teardown stops them; they stay set up while the
    /// view is off screen, so a page closing over it finds them intact.
    func stopAnimators() {
        for animator in animators {
            animator.stopAnimation(true)
        }
        animators = []
    }
}
