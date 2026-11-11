import SwiftUI
import UIKit

/// How the game was opened: from the update page, which keeps its status
/// in a strip at the top, or from the chat header's mascot.
struct StackGameLaunch: Identifiable, Equatable {
    enum Sample: Equatable { case start, playing, over }

    let id = UUID()
    var fromUpdate = false
    /// A fixed game for the snapshot runner: nothing moves and the best
    /// score on this device is neither read nor written.
    var sample: Sample? = nil
}

/// "Stack up", full screen over the app. The tower is drawn in a `Canvas`;
/// every moving part is a function of time since the last event, so the
/// timeline only reads the game and taps are the only writes.
struct StackGameScreen: View {
    let launch: StackGameLaunch
    let onClose: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var game: StackGame?
    @State private var effects = StackEffects()
    @State private var epoch = Date()
    @State private var dropHaptic = UIImpactFeedbackGenerator(style: .light)
    @State private var perfectHaptic = UIImpactFeedbackGenerator(style: .medium)
    @State private var endHaptic = UINotificationFeedbackGenerator()

    /// The widest the blocks travel, so an iPad's slide stays a phone's length.
    static let maxFieldWidth: CGFloat = 520
    /// The tower's foot, as a share of the screen's height.
    static let groundShare: CGFloat = 0.78
    /// The sliding block stays at about this share from the top.
    static let followShare: CGFloat = 0.33
    static let mascotWidth: CGFloat = 38
    static var mascotHeight: CGFloat { mascotWidth * Mascot.viewBox.height / Mascot.viewBox.width }
    /// The sliding block runs this far above its slot, clear of the mascot.
    static let hover: CGFloat = 46
    /// A dropped block eases down into its slot in this long.
    static let landTime: TimeInterval = 0.1
    static let blockRadius: CGFloat = 7
    /// Between two blocks of a merged slab.
    static let slabRadius: CGFloat = 2
    /// The darker band along a block's bottom.
    static let lip: CGFloat = 4
    /// The page reaches its dusk tone at this many blocks.
    static let duskAt: CGFloat = 45
    /// The dot grid's spacing, and how much of the tower's climb it follows.
    static let dotSpacing: CGFloat = 24
    static let dotParallax: CGFloat = 0.35
    /// At the end: the mascot's tumble to the ground, the camera easing out
    /// to the whole tower, and the toast's time on screen.
    static let tumbleTime: TimeInterval = 0.9
    static let fitDelay: TimeInterval = 0.5
    static let fitTime: TimeInterval = 0.9
    static let toastFrom: TimeInterval = 0.25
    static let toastTime: TimeInterval = 1.2
    /// After the toast, the mascot offers another game.
    static var againAfter: TimeInterval { toastFrom + toastTime }
    /// Below the HUD: the fitted tower keeps under this share of the screen.
    static let fitTopShare: CGFloat = 0.3

    private var frozen: Bool { launch.sample != nil }

    var body: some View {
        ZStack {
            GeometryReader { geometry in
                let fieldWidth = min(geometry.size.width, Self.maxFieldWidth)
                Group {
                    if let game {
                        field(game, size: geometry.size, fieldWidth: fieldWidth)
                    } else {
                        Palette.bg
                    }
                }
                .onAppear {
                    guard game == nil else { return }
                    let first = makeGame(fieldWidth: fieldWidth)
                    // A lost sample shows its end, long settled.
                    effects = StackEffects(level: first.placed, ended: first.phase == .over ? -100 : nil)
                    game = first
                    dropHaptic.prepare()
                }
            }
            .ignoresSafeArea()
            if let game {
                hud(game)
            }
        }
        .overlay(alignment: .top) { topBar }
    }

    // MARK: Playing

    private func makeGame(fieldWidth: CGFloat) -> StackGame {
        switch launch.sample {
        case .start: return StackGame(fieldWidth: fieldWidth, best: 64)
        case .playing: return .sample(fieldWidth: fieldWidth, best: 64, over: false)
        case .over: return .sample(fieldWidth: fieldWidth, best: 24, over: true)
        case nil: return StackGame(fieldWidth: fieldWidth, best: StackGameBest.load())
        }
    }

    /// Seconds since the screen opened; fixed for a snapshot.
    private func clock(_ date: Date = .now) -> TimeInterval {
        frozen ? 0.6 : date.timeIntervalSince(epoch)
    }

    /// A tap at `point` in the field; nil from VoiceOver, which always counts.
    /// Before the start and after the end, only the mascot answers.
    private func tap(at point: CGPoint?, size: CGSize, fieldWidth: CGFloat) {
        guard var next = game, !frozen else { return }
        let now = clock()
        if next.phase == .over {
            guard let ended = effects.ended, now - ended >= Self.againAfter else { return }
        }
        if let point {
            let shown = effects.shownLevel(at: now, reduceMotion: reduceMotion)
            let pose = mascotPose(next, layout: layout(next, size: size, fieldWidth: fieldWidth, shown: shown, now: now), shown: shown, now: now)
            guard next.tapCounts(at: point, mascot: pose.center) else { return }
        }
        switch next.phase {
        case .ready:
            next.start(at: now)
            dropHaptic.impactOccurred()
        case .playing:
            let level = next.tower.count
            guard let drop = next.drop(at: now) else { return }
            effects.record(drop, level: level, game: next, at: now)
            switch drop {
            case .perfect:
                perfectHaptic.impactOccurred()
            case .cut:
                dropHaptic.impactOccurred()
            case .miss:
                endHaptic.notificationOccurred(.error)
                StackGameBest.save(next.best)
            }
        case .over:
            dropHaptic.impactOccurred()
            playAgain()
            return
        }
        dropHaptic.prepare()
        game = next
    }

    private func playAgain() {
        guard var next = game else { return }
        next.restart()
        effects = StackEffects()
        epoch = .now
        game = next
    }

    // MARK: The field

    /// The field's layout with the tower shown `shown` levels high: the
    /// camera keeps the sliding block in the upper third. After the end it
    /// eases out until the whole tower fits under the score, scaled down
    /// for a tall one: the frame worth a screenshot.
    private func layout(_ game: StackGame, size: CGSize, fieldWidth: CGFloat, shown: CGFloat, now: TimeInterval) -> FieldLayout {
        let groundY = size.height * Self.groundShare
        var layout = FieldLayout(left: (size.width - fieldWidth) / 2, groundY: groundY, camera: 0, size: size)
        layout.camera = max(0, (shown + 2) * StackGame.blockHeight + Self.hover - (groundY - size.height * Self.followShare))
        guard game.phase == .over, let ended = effects.ended else { return layout }
        let towerHeight = CGFloat(game.tower.count) * StackGame.blockHeight + 8
        let room = groundY - size.height * Self.fitTopShare
        let fit = min(1, room / towerHeight)
        let progress = reduceMotion ? 1 : min(max((now - ended - Self.fitDelay) / Self.fitTime, 0), 1)
        let eased = CGFloat(progress < 0.5 ? 4 * pow(progress, 3) : 1 - pow(-2 * progress + 2, 3) / 2)
        layout.camera *= 1 - eased
        layout.scale = 1 + (fit - 1) * eased
        return layout
    }

    private func field(_ game: StackGame, size: CGSize, fieldWidth: CGFloat) -> some View {
        let left = (size.width - fieldWidth) / 2
        return TimelineView(.animation(minimumInterval: 1.0 / 60, paused: frozen)) { context in
            let now = clock(context.date)
            let shown = effects.shownLevel(at: now, reduceMotion: reduceMotion)
            let layout = layout(game, size: size, fieldWidth: fieldWidth, shown: shown, now: now)
            let pose = mascotPose(game, layout: layout, shown: shown, now: now)
            ZStack(alignment: .topLeading) {
                Canvas { canvas, _ in
                    draw(game, in: &canvas, now: now, layout: layout, shown: shown, mascot: pose)
                } symbols: {
                    slabLabel("skill").tag(StackGame.Tier.skill)
                    slabLabel("app").tag(StackGame.Tier.app)
                }
                // The ground: one line, then a giant faded "Rome" under it,
                // like a site footer's logo, dissolving into the ground.
                anchored(at: CGPoint(x: size.width / 2, y: layout.y(0) + 18), alignment: .top) {
                    Text("Every block builds on the last.")
                        .romeFont(13)
                        .foregroundStyle(Palette.sub)
                        .multilineTextAlignment(.center)
                        .frame(width: min(fieldWidth - 48, 320))
                }
                anchored(at: CGPoint(x: size.width / 2, y: layout.y(0) + 22), alignment: .top) {
                    GroundWordmark(width: min(size.width, Metrics.readableWidth) - Metrics.pagePadding * 2)
                }
                if game.phase == .ready {
                    anchored(at: CGPoint(x: pose.center.x, y: pose.top - 6), alignment: .bottom) {
                        MascotBubble(text: "Tap me to start")
                    }
                }
                if game.phase == .over, let ended = effects.ended {
                    let age = now - ended
                    if age >= Self.againAfter {
                        // Running right from the mascot; it may cover some of the tower.
                        anchored(at: CGPoint(x: pose.center.x - MascotBubble.tailInset, y: pose.top - 6), alignment: .bottomLeading) {
                            MascotBubble(text: "Play again", tailLeading: true)
                        }
                    }
                    if age >= Self.toastFrom, age < Self.againAfter {
                        let into = (age - Self.toastFrom) / Self.toastTime
                        toast(game)
                            .position(x: size.width / 2, y: size.height * 0.45)
                            .opacity(min(into / 0.15, 1, (1 - into) / 0.25))
                    }
                }
                ForEach(effects.floats) { float in
                    let age = now - float.start
                    if age >= 0, age < StackEffects.floatLife {
                        let progress = age / StackEffects.floatLife
                        floatView(float)
                            .position(
                                x: left + fieldWidth / 2,
                                y: layout.y(CGFloat(float.level + 1) * StackGame.blockHeight) - Self.hover - 18 - CGFloat(float.row) * 36 - (reduceMotion ? 0 : 36 * progress)
                            )
                            .opacity(1 - progress * progress)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { point in tap(at: point, size: size, fieldWidth: fieldWidth) }
        .accessibilityElement()
        .accessibilityLabel(Text("Stack up"))
        .accessibilityValue(Text(verbatim: "\(game.score)"))
        .accessibilityHint(Text("Tap to drop the block"))
        .accessibilityAddTraits(.allowsDirectInteraction)
        .accessibilityAction { tap(at: nil, size: size, fieldWidth: fieldWidth) }
    }

    /// Where the field's world (heights from the ground up) lands on screen.
    /// Where the field's world (heights from the ground up) lands on
    /// screen. `scale` shrinks it toward the ground's middle.
    private struct FieldLayout {
        var left: CGFloat
        var groundY: CGFloat
        var camera: CGFloat
        var size: CGSize
        var scale: CGFloat = 1

        func x(_ world: CGFloat) -> CGFloat { size.width / 2 + (left + world - size.width / 2) * scale }
        func y(_ height: CGFloat) -> CGFloat { groundY - height * scale + camera }

        func rect(_ block: StackGame.Block, level: Int, height: CGFloat = StackGame.blockHeight) -> CGRect {
            CGRect(x: x(block.x), y: y(CGFloat(level + 1) * StackGame.blockHeight), width: block.width * scale, height: height * scale)
        }
    }

    /// A view with one edge pinned to a point, whatever its size.
    private func anchored<Content: View>(at point: CGPoint, alignment: Alignment, @ViewBuilder _ content: () -> Content) -> some View {
        Color.clear
            .frame(width: 0, height: 0)
            .overlay(alignment: alignment) { content().fixedSize(horizontal: false, vertical: true) }
            .position(point)
    }

    private func draw(_ game: StackGame, in canvas: inout GraphicsContext, now: TimeInterval, layout: FieldLayout, shown: CGFloat, mascot: MascotPlacement) {
        let h = StackGame.blockHeight
        let size = layout.size
        // The page: warm, toward dusk as the tower rises; flat in each frame.
        canvas.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Palette.blend(Palette.bg, Palette.stackDusk, shown / Self.duskAt)))
        // A faint dot grid, climbing slower than the tower.
        let spacing = Self.dotSpacing
        let drift = (layout.camera * Self.dotParallax).truncatingRemainder(dividingBy: spacing)
        var dots = Path()
        var row = drift - spacing
        while row < size.height {
            var column = spacing / 2
            while column < size.width {
                dots.addEllipse(in: CGRect(x: column - 1, y: row - 1, width: 2, height: 2))
                column += spacing
            }
            row += spacing
        }
        canvas.fill(dots, with: .color(Palette.fg.opacity(colorScheme == .dark ? 0.06 : 0.05)))
        // The ground under the base.
        let groundTop = layout.y(0)
        if groundTop < size.height {
            canvas.fill(Path(CGRect(x: 0, y: groundTop, width: size.width, height: size.height - groundTop)), with: .color(Palette.stackGround))
        }

        let landing = effects.landing(at: now, reduceMotion: reduceMotion)
        for (level, block) in game.tower.enumerated() {
            let slab = Slab(level: level, tier: block.tier)
            // A slab's blocks touch; other blocks keep a gap below.
            // Half a point over the block below, so a slab shows no seam.
            var frame = layout.rect(block, level: level, height: level == 0 ? h : slab.joinsBelow ? h + 0.5 : h - 2)
            if level == game.tower.count - 1, landing > 0 {
                frame.origin.y -= Self.hover * layout.scale * landing
            }
            guard frame.maxY > -h, frame.minY < size.height else { continue }
            let color = level == 0 ? Palette.stackStone : Self.color(block.tier)
            drawBlock(frame, color: color, top: slab.joinsAbove ? Self.slabRadius : Self.blockRadius, bottom: slab.joinsBelow ? Self.slabRadius : Self.blockRadius, lip: !slab.joinsBelow, highlight: !slab.joinsAbove, in: &canvas)
            if slab.isMiddle, frame.width >= 56, let label = canvas.resolveSymbol(id: block.tier) {
                canvas.draw(label, at: CGPoint(x: frame.midX, y: frame.midY - 1))
            }
            if let flash = effects.flash, flash.levels.contains(level) {
                let progress = (now - flash.start) / StackEffects.flashLife
                if progress >= 0, progress < 1 {
                    canvas.fill(Path(roundedRect: frame, cornerRadius: Self.slabRadius, style: .continuous), with: .color(.white.opacity(0.85 * (1 - progress))))
                }
            }
        }

        if game.phase == .playing {
            let block = StackGame.Block(x: game.movingX(at: now), width: game.slide.width)
            let frame = layout.rect(block, level: game.tower.count, height: h - 2).offsetBy(dx: 0, dy: -Self.hover)
            // The aiming aid: the top block's edges, up to the sliding block.
            let top = game.top
            // A thin top would leave them as stray hairlines: they fade out.
            let guideOpacity = min(max((top.width - 4) / 8, 0), 1)
            if guideOpacity > 0 {
                let topY = layout.y(CGFloat(game.tower.count) * h)
                var guides = Path()
                for x in [layout.x(top.x), layout.x(top.right)] {
                    guides.move(to: CGPoint(x: x, y: topY))
                    guides.addLine(to: CGPoint(x: x, y: frame.maxY))
                }
                canvas.stroke(guides, with: .color(Palette.fg.opacity(0.2 * guideOpacity)), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            }
            drawBlock(frame, color: Self.color(.action), top: Self.blockRadius, bottom: Self.blockRadius, lip: true, highlight: true, in: &canvas)
        }

        if !reduceMotion, let ring = effects.ring, ring.level < game.tower.count {
            let progress = (now - ring.start) / StackEffects.ringLife
            if progress >= 0, progress < 1 {
                let frame = layout.rect(game.tower[ring.level], level: ring.level, height: h - 2)
                let p = CGFloat(progress)
                let grown = frame.insetBy(dx: -14 * p, dy: -10 * p)
                canvas.stroke(Path(roundedRect: grown, cornerRadius: Self.blockRadius + 6 * p, style: .continuous), with: .color(Palette.primary.opacity(1 - Double(p))), lineWidth: 2.5 - 1.5 * p)
                // A few sparks off the top edge.
                for spark in 0..<6 {
                    let share = CGFloat(spark) / 5
                    let x = frame.minX + frame.width * share + (share - 0.5) * 60 * p
                    let y = frame.minY - 70 * p + 120 * p * p
                    let radius = 2.4 * (1 - p)
                    canvas.fill(Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)), with: .color(Palette.primary))
                }
            }
        }

        // Overhangs tumbling away, from where they slid.
        for piece in effects.falling {
            let age = now - piece.start
            guard age >= 0, age < StackEffects.fallLife else { continue }
            let t = CGFloat(age)
            var frame = layout.rect(piece.block, level: piece.level, height: h - 2).offsetBy(dx: 0, dy: -Self.hover * layout.scale)
            frame.origin.x += piece.drift * 40 * t
            frame.origin.y += 0.5 * 1800 * t * t
            var context = canvas
            context.opacity = 1 - Double(t) / StackEffects.fallLife
            context.translateBy(x: frame.midX, y: frame.midY)
            context.rotate(by: .degrees(Double(piece.drift) * 160 * Double(t)))
            drawBlock(CGRect(x: -frame.width / 2, y: -frame.height / 2, width: frame.width, height: frame.height), color: Self.color(piece.block.tier), top: Self.blockRadius, bottom: Self.blockRadius, lip: true, highlight: true, in: &context)
        }

        drawMascot(mascot, in: &canvas)
    }

    /// A block: rounded, with a darker lip along its bottom and a hairline
    /// highlight along its top.
    private func drawBlock(_ drawn: CGRect, color: Color, top: CGFloat, bottom: CGFloat, lip: Bool, highlight: Bool, in canvas: inout GraphicsContext) {
        // A sliver still reads as a block, not a hairline.
        let frame = drawn.width >= 2 ? drawn : drawn.insetBy(dx: (drawn.width - 2) / 2, dy: 0)
        let top = min(top, frame.height / 2), bottom = min(bottom, frame.height / 2)
        let shape = UnevenRoundedRectangle(topLeadingRadius: top, bottomLeadingRadius: bottom, bottomTrailingRadius: bottom, topTrailingRadius: top, style: .continuous).path(in: frame)
        canvas.fill(shape, with: .color(color))
        guard lip || highlight else { return }
        var inside = canvas
        inside.clip(to: shape)
        if lip {
            inside.fill(Path(CGRect(x: frame.minX, y: frame.maxY - Self.lip, width: frame.width, height: Self.lip)), with: .color(.black.opacity(colorScheme == .dark ? 0.28 : 0.16)))
        }
        if highlight {
            inside.fill(Path(CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: 1)), with: .color(.white.opacity(colorScheme == .dark ? 0.2 : 0.5)))
        }
    }

    /// Where a block sits in a merged group, by its level: five skill
    /// blocks or twenty-five app blocks make one slab.
    private struct Slab {
        var joinsBelow = false
        var joinsAbove = false
        var isMiddle = false

        init(level: Int, tier: StackGame.Tier) {
            let size: Int
            switch tier {
            case .action: return
            case .skill: size = StackGame.skillEvery
            case .app: size = StackGame.appEvery
            }
            let place = (level - 1) % size
            joinsBelow = place > 0
            joinsAbove = place < size - 1
            isMiddle = place == size / 2
        }
    }

    /// Where and how the mascot is drawn: the point it turns about (its
    /// foot standing, its back lying down), its angle, its width on screen
    /// and its face.
    struct MascotPlacement {
        var anchor: CGPoint
        var angle: Double = 0
        var width: CGFloat
        var face = MascotPose.rest

        var height: CGFloat { width * Mascot.viewBox.height / Mascot.viewBox.width }
        /// Lying on its side once it has landed.
        var lying: Bool { angle.truncatingRemainder(dividingBy: 360) == 90 }
        /// The middle of the figure on screen, for a tap.
        var center: CGPoint {
            lying ? CGPoint(x: anchor.x + height / 2, y: anchor.y) : CGPoint(x: anchor.x, y: anchor.y - height / 2)
        }
        /// The figure's top edge on screen, for its bubble.
        var top: CGFloat { lying ? anchor.y - width / 2 : anchor.y - height }
    }

    /// Standing on the tower's middle and riding up as it grows; hopping on
    /// a perfect and shaking on a cut. After the end it tumbles off the top
    /// and lands lying on the ground beside the base.
    private func mascotPose(_ game: StackGame, layout: FieldLayout, shown: CGFloat, now: TimeInterval) -> MascotPlacement {
        // It shrinks with a fitted tower, but stays easy to see and tap.
        let width = Self.mascotWidth * max(layout.scale, 0.8)
        let moves = !reduceMotion && !frozen
        var face = MascotPose.rest
        if moves {
            let alive = MascotPose(time: now + 1)
            face.eyeScale = alive.eyeScale
            // Waiting for a tap, it looks about too.
            if game.phase != .playing { face.glance = alive.glance }
        }
        let top = game.top
        let standing = CGPoint(x: top.x + top.width / 2, y: (shown + 1) * StackGame.blockHeight)
        if game.phase == .over, let ended = effects.ended {
            // Its back on the ground, just right of the base, head away from it.
            let from = CGPoint(x: layout.x(standing.x), y: layout.y(standing.y))
            let to = CGPoint(x: layout.x(game.tower[0].right) + 8, y: layout.y(0) - width / 2)
            let progress = moves ? min(max((now - ended) / Self.tumbleTime, 0), 1) : 1
            let p = CGFloat(progress)
            let anchor = CGPoint(
                x: from.x + (to.x - from.x) * p,
                y: from.y + (to.y - from.y) * p * p - 60 * sin(.pi * p)
            )
            return MascotPlacement(anchor: anchor, angle: 450 * progress, width: width, face: face)
        }
        var anchor = CGPoint(x: layout.x(standing.x), y: layout.y(standing.y))
        if moves, let event = effects.mascot {
            let age = now - event.start
            switch event.kind {
            case .hop where age < 0.4:
                anchor.y -= 18 * sin(.pi * age / 0.4)
            case .shake where age < 0.35:
                anchor.x += 3 * sin(age / 0.35 * 6 * .pi) * (1 - age / 0.35)
            default:
                break
            }
        }
        return MascotPlacement(anchor: anchor, width: width, face: face)
    }

    private func drawMascot(_ placement: MascotPlacement, in canvas: inout GraphicsContext) {
        var context = canvas
        context.translateBy(x: placement.anchor.x, y: placement.anchor.y)
        context.rotate(by: .degrees(placement.angle))
        let scale = placement.width / Mascot.viewBox.width
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -Mascot.viewBox.width / 2, y: -Mascot.viewBox.height)
        let shape = { (data: String) in SVGPath.cached(data) }
        context.fill(shape(MascotPaths.body), with: .color(Palette.fg))
        context.fill(shape(MascotPaths.headFill), with: .color(Palette.fg))
        context.fill(shape(MascotPaths.headRing), with: .color(Palette.fg))
        context.fill(shape(MascotPaths.screen), with: .color(Palette.bg))
        context.stroke(shape(MascotPaths.screen), with: .color(Palette.fg), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
        var face = context
        let anchor = CGPoint(x: MascotPaths.eyeAnchor.x * Mascot.viewBox.width, y: MascotPaths.eyeAnchor.y * Mascot.viewBox.height)
        face.translateBy(x: anchor.x + placement.face.glance, y: anchor.y)
        face.scaleBy(x: 1, y: placement.face.eyeScale)
        face.translateBy(x: -anchor.x, y: -anchor.y)
        for eye in [MascotPaths.leftEye, MascotPaths.rightEye] {
            face.fill(shape(eye), with: .color(Palette.fg))
            face.stroke(shape(eye), with: .color(Palette.fg), style: StrokeStyle(lineWidth: 2, lineJoin: .round))
        }
    }

    static func color(_ tier: StackGame.Tier) -> Color {
        switch tier {
        case .action: return Palette.stackAction
        case .skill: return Palette.stackSkill
        case .app: return Palette.stackApp
        }
    }

    /// The tier's name on a merged slab. The words stay English in every
    /// language, as the ground's line uses them.
    private func slabLabel(_ word: String) -> some View {
        Text(verbatim: word)
            .romeFont(10, .semibold)
            .tracking(0.4)
            .foregroundStyle(.white.opacity(0.92))
    }

    @ViewBuilder
    private func floatView(_ float: StackEffects.Float) -> some View {
        if float.emphasis {
            Text(verbatim: float.text)
                .romeFont(17, .bold, design: .rounded)
                .foregroundStyle(Palette.primaryText)
                .fixedSize()
        } else {
            Text(verbatim: float.text)
                .romeFont(13, .semibold)
                .foregroundStyle(Palette.fg)
                .fixedSize()
                .padding(.horizontal, 12)
                .frame(height: 28)
                .glassSurface(Capsule())
        }
    }

    // MARK: Over the field

    /// Where closing goes: the update page while it still covers the app,
    /// else the chat.
    private var backTitle: LocalizedStringKey {
        launch.fromUpdate && model.update.blocking ? "Back to update" : "Back to chat"
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            if launch.fromUpdate {
                UpdateStrip()
                    .layoutPriority(-1)
            }
            Spacer(minLength: 0)
            Button(action: onClose) {
                Text(backTitle)
                    .romeFont(14, .semibold)
                    .foregroundStyle(Palette.fg)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .glassSurface(Capsule(), interactive: true)
                    .contentShape(Capsule())
            }
            .buttonStyle(GlassPressStyle())
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    /// The score, and under it the combo and best while playing; at the
    /// end the blocks placed and the best, or "New best" in coral.
    private func hud(_ game: StackGame) -> some View {
        VStack(spacing: 10) {
            Text(verbatim: "\(game.score)")
                .romeFont(60, .bold, design: .rounded, monospacedDigits: true)
                .foregroundStyle(Palette.fg)
                .contentTransition(.numericText())
            capsuleLine(game)
                .romeFont(14, .semibold, monospacedDigits: true)
                .padding(.horizontal, 14)
                .frame(height: 30)
                .glassSurface(Capsule())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 60)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func capsuleLine(_ game: StackGame) -> Text {
        let dot = Text(verbatim: "  ·  ").foregroundStyle(Palette.sub)
        let best = Text("Best \(game.best)").foregroundStyle(Palette.sub)
        if game.phase == .over {
            let blocks = Text("\(game.placed) blocks").foregroundStyle(Palette.sub)
            return blocks + dot + (game.newBest ? Text("New best").foregroundStyle(Palette.primaryText) : best)
        }
        // The combo only once there is one.
        guard game.multiplier > 1 else { return best }
        return Text(verbatim: "×\(game.multiplier)").foregroundStyle(Palette.primaryText) + dot + best
    }

    /// Said once over the tower at the end, then gone.
    private func toast(_ game: StackGame) -> some View {
        Text(game.newBest ? "New best" : "Game over")
            .romeFont(17, .semibold)
            .foregroundStyle(game.newBest ? Palette.primaryText : Palette.fg)
            .fixedSize()
            .padding(.horizontal, 18)
            .frame(height: 40)
            .glassSurface(Capsule())
            .allowsHitTesting(false)
    }
}

/// "Rome" across the ground, in the opening screen's wordmark style, as
/// wide as the page allows; a shade off the ground, gone by two-thirds
/// of its height. Decoration only.
private struct GroundWordmark: View {
    let width: CGFloat

    var body: some View {
        Text(verbatim: "Rome")
            .romeFont(320, .medium)
            .tracking(-6)
            .lineLimit(1)
            .minimumScaleFactor(0.05)
            .foregroundStyle(Palette.stackWordmark)
            .frame(width: width)
            .mask {
                LinearGradient(stops: [.init(color: .black, location: 0.2), .init(color: .clear, location: 0.67)], startPoint: .top, endPoint: .bottom)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The mascot's line in a glass bubble whose tail points down at it.
private struct MascotBubble: View {
    let text: LocalizedStringKey
    /// The tail near the leading edge rather than the middle.
    var tailLeading = false

    /// How far in from the leading edge a leading tail sits.
    static let tailInset: CGFloat = 26

    var body: some View {
        Text(text)
            .romeFont(14, .semibold)
            .foregroundStyle(Palette.fg)
            .fixedSize()
            .padding(.horizontal, 14)
            .padding(.top, 9)
            .padding(.bottom, 9 + SpeechBubble.tail)
            .glassSurface(SpeechBubble(tailInset: tailLeading ? Self.tailInset : nil))
            .allowsHitTesting(false)
    }
}

/// A rounded box with a small tail at the middle of its bottom edge.
private struct SpeechBubble: InsettableShape {
    static let tail: CGFloat = 7
    /// The tail's distance from the leading edge; nil puts it in the middle.
    var tailInset: CGFloat? = nil
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let frame = rect.insetBy(dx: inset, dy: inset)
        let body = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height - Self.tail)
        var path = Path(roundedRect: body, cornerRadius: min(16, body.height / 2), style: .continuous)
        let tail = max(Self.tail - inset, 0)
        let tip = tailInset.map { rect.minX + $0 } ?? body.midX
        path.move(to: CGPoint(x: tip - tail, y: body.maxY - 1))
        path.addLine(to: CGPoint(x: tip, y: body.maxY + tail))
        path.addLine(to: CGPoint(x: tip + tail, y: body.maxY - 1))
        path.closeSubpath()
        return path
    }

    func inset(by amount: CGFloat) -> SpeechBubble {
        var shape = self
        shape.inset += amount
        return shape
    }
}

/// The update page's status while the game covers it. When the upgrade
/// lands, it says the release reached; nothing interrupts the game.
private struct UpdateStrip: View {
    @Environment(AppModel.self) private var model
    /// The release being upgraded to, kept once the upgrade ends.
    @State private var target: String?

    private var updater: InstanceUpdater { model.update }

    var body: some View {
        Group {
            switch updater.state {
            case .starting, .updating:
                row {
                    Spinner(size: 13, lineWidth: 1.8, color: Palette.sub)
                    if let line = UpdateGate.statusLine(updater.state, progress: updater.progress, agentName: model.workspace?.agentName) {
                        Text(line)
                    }
                }
            case .failed(.timedOut):
                row {
                    AlertGlyph(size: 13)
                    Text("The update is taking too long")
                }
            case .failed(.start):
                row {
                    AlertGlyph(size: 13)
                    Text("Could not start the update")
                }
            default:
                if let version = updater.updatedTo ?? target {
                    row {
                        Image(systemName: "checkmark").romeFont(12, .semibold).foregroundStyle(Palette.success)
                        Text("Your Rome is on \(version).")
                    }
                }
            }
        }
        .onAppear { remember(updater.state) }
        .onChange(of: updater.state) { _, state in remember(state) }
        .animation(.easeInOut(duration: 0.25), value: updater.state)
    }

    private func remember(_ state: InstanceUpdater.State) {
        switch state {
        case .starting(_, let latest): target = latest
        case .updating(let release, _): target = release
        default: break
        }
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8) { content() }
            .romeFont(13, .medium)
            .foregroundStyle(Palette.fg)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .padding(.horizontal, 12)
            .frame(height: 38)
            .glassSurface(Capsule())
            .accessibilityElement(children: .combine)
    }
}

/// What the screen animates after each drop, each from the time it began.
struct StackEffects {
    struct Falling {
        var block: StackGame.Block
        var level: Int
        /// -1 falls to the left, 1 to the right.
        var drift: CGFloat
        var start: TimeInterval
    }

    struct Float: Identifiable {
        let id = UUID()
        var text: String
        var level: Int
        /// Stacked lines: 0 nearest the tower.
        var row: Int
        /// "Perfect" in coral; otherwise a merge's glass pill.
        var emphasis: Bool
        var start: TimeInterval
    }

    struct MascotEvent {
        enum Kind { case hop, shake }
        var kind: Kind
        var start: TimeInterval
    }

    static let fallLife: TimeInterval = 1.2
    static let floatLife: TimeInterval = 1.1
    static let riseTime: TimeInterval = 0.25
    static let ringLife: TimeInterval = 0.5
    static let flashLife: TimeInterval = 0.35

    private(set) var falling: [Falling] = []
    private(set) var floats: [Float] = []
    private(set) var mascot: MascotEvent?
    /// A perfect drop's ring, around the block at this level.
    private(set) var ring: (level: Int, start: TimeInterval)?
    /// A merge: its blocks flash white.
    private(set) var flash: (levels: ClosedRange<Int>, start: TimeInterval)?
    /// When the last drop missed.
    private(set) var ended: TimeInterval?
    /// The tower's height the camera and mascot ease from and to, in levels.
    private var rise: (from: CGFloat, to: CGFloat, start: TimeInterval)

    /// Resting on a tower `level` blocks high; `ended` for a game already over.
    init(level: Int = 0, ended: TimeInterval? = nil) {
        rise = (CGFloat(level), CGFloat(level), 0)
        self.ended = ended
    }

    mutating func record(_ drop: StackGame.Drop, level: Int, game: StackGame, at time: TimeInterval) {
        falling.removeAll { time - $0.start > Self.fallLife }
        floats.removeAll { time - $0.start > Self.floatLife }
        switch drop {
        case .perfect(let combo, _, let merge):
            let text = combo > 1 ? String(localized: "Perfect ×\(combo)") : String(localized: "Perfect")
            floats.append(Float(text: text, level: level, row: 0, emphasis: true, start: time))
            mascot = MascotEvent(kind: .hop, start: time)
            ring = (level, time)
            noteMerge(merge, level: level, row: 1, at: time)
        case .cut(let piece, _, let merge):
            let below = game.tower[level - 1]
            falling.append(Falling(block: piece, level: level, drift: piece.x < below.x ? -1 : 1, start: time))
            mascot = MascotEvent(kind: .shake, start: time)
            noteMerge(merge, level: level, row: 0, at: time)
        case .miss(let block):
            let below = game.top
            falling.append(Falling(block: block, level: level, drift: block.x < below.x ? -1 : 1, start: time))
            mascot = nil
            ended = time
            return
        }
        rise = (from: CGFloat(level - 1), to: CGFloat(level), start: time)
    }

    private mutating func noteMerge(_ merge: StackGame.Merge?, level: Int, row: Int, at time: TimeInterval) {
        guard let merge else { return }
        let count = merge == .skill ? StackGame.skillEvery : StackGame.appEvery
        flash = (max(level - count + 1, 1)...level, time + StackGameScreen.landTime)
        let text = merge == .skill ? String(localized: "5 actions → 1 skill") : String(localized: "5 skills → 1 app")
        floats.append(Float(text: text, level: level, row: row, emphasis: false, start: time + 0.12))
    }

    /// How far the last placed block still is above its slot, 1 to 0.
    func landing(at time: TimeInterval, reduceMotion: Bool) -> CGFloat {
        guard !reduceMotion, rise.to > rise.from else { return 0 }
        let progress = min(max((time - rise.start) / StackGameScreen.landTime, 0), 1)
        return CGFloat(1 - progress * progress)
    }

    /// The top level the camera and the mascot show at `time`, easing up
    /// after each drop.
    func shownLevel(at time: TimeInterval, reduceMotion: Bool) -> CGFloat {
        let progress = reduceMotion ? 1 : min(max((time - rise.start) / Self.riseTime, 0), 1)
        let eased = 1 - pow(1 - progress, 3)
        return rise.from + (rise.to - rise.from) * CGFloat(eased)
    }
}
