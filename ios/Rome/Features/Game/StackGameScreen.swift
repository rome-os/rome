import SwiftUI
import UIKit

/// How the game was opened: from the update page, which keeps its status
/// in a strip at the top, or from the chat header's mascot.
struct StackGameLaunch: Identifiable, Equatable {
    enum Sample: Equatable { case playing, over }

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
    @State private var game: StackGame?
    @State private var effects = StackEffects()
    @State private var epoch = Date()
    @State private var dropHaptic = UIImpactFeedbackGenerator(style: .light)
    @State private var perfectHaptic = UIImpactFeedbackGenerator(style: .medium)
    @State private var endHaptic = UINotificationFeedbackGenerator()

    /// The widest the blocks travel, so an iPad's slide stays a phone's length.
    static let maxFieldWidth: CGFloat = 520
    /// The tower's foot, as a share of the screen's height.
    static let groundShare: CGFloat = 0.8
    /// The sliding block stays at about this share from the top.
    static let followShare: CGFloat = 0.33
    static let mascotWidth: CGFloat = 30
    /// The sliding block runs this far above its slot, clear of the mascot.
    static let hover: CGFloat = 34
    /// A dropped block eases down into its slot in this long.
    static let landTime: TimeInterval = 0.1

    private var frozen: Bool { launch.sample != nil }

    var body: some View {
        GeometryReader { geometry in
            let fieldWidth = min(geometry.size.width, Self.maxFieldWidth)
            ZStack {
                Palette.bg.ignoresSafeArea()
                if let game {
                    field(game, size: geometry.size, fieldWidth: fieldWidth)
                    hud(game)
                    if game.phase == .over {
                        overCard(game)
                            .transition(.opacity)
                    }
                }
            }
            .animation(.easeOut(duration: 0.3).delay(reduceMotion ? 0 : 0.5), value: game?.phase == .over)
            .onAppear {
                guard game == nil else { return }
                let first = makeGame(fieldWidth: fieldWidth)
                effects = StackEffects(level: first.placed)
                game = first
                dropHaptic.prepare()
            }
        }
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottom) { legend }
    }

    // MARK: Playing

    private func makeGame(fieldWidth: CGFloat) -> StackGame {
        switch launch.sample {
        case .playing: return .sample(fieldWidth: fieldWidth, best: 64, over: false)
        case .over: return .sample(fieldWidth: fieldWidth, best: 24, over: true)
        case nil: return StackGame(fieldWidth: fieldWidth, best: StackGameBest.load())
        }
    }

    /// Seconds since the screen opened; fixed for a snapshot.
    private func clock(_ date: Date = .now) -> TimeInterval {
        frozen ? 0.6 : date.timeIntervalSince(epoch)
    }

    private func tap() {
        guard var next = game, !frozen else { return }
        let now = clock()
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

    // MARK: Drawing

    private func field(_ game: StackGame, size: CGSize, fieldWidth: CGFloat) -> some View {
        let groundY = size.height * Self.groundShare
        let left = (size.width - fieldWidth) / 2
        return TimelineView(.animation(minimumInterval: 1.0 / 60, paused: frozen)) { context in
            let now = clock(context.date)
            let shown = effects.shownLevel(at: now, reduceMotion: reduceMotion)
            let camera = max(0, (shown + 2) * StackGame.blockHeight + Self.hover - (groundY - size.height * Self.followShare))
            let screenY = { (height: CGFloat) in groundY - height + camera }
            ZStack(alignment: .topLeading) {
                Canvas { canvas, _ in
                    draw(game, in: &canvas, now: now, left: left, groundY: groundY, screenY: screenY, shown: shown, height: size.height)
                }
                ForEach(effects.floats) { float in
                    let age = now - float.start
                    if age >= 0, age < StackEffects.floatLife {
                        let progress = age / StackEffects.floatLife
                        Text(verbatim: float.text)
                            .romeFont(float.emphasis ? 17 : 14, .semibold)
                            .foregroundStyle(float.emphasis ? Palette.primaryText : Palette.sub)
                            .fixedSize()
                            .position(
                                x: left + fieldWidth / 2,
                                y: screenY(CGFloat(float.level + 1) * StackGame.blockHeight) - 28 - CGFloat(float.row) * 22 - (reduceMotion ? 0 : 36 * progress)
                            )
                            .opacity(1 - progress * progress)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: tap)
        .accessibilityElement()
        .accessibilityLabel(Text("Stack up"))
        .accessibilityValue(Text("\(game.score)"))
        .accessibilityHint(Text("Tap to drop the block"))
        .accessibilityAddTraits(.allowsDirectInteraction)
        .accessibilityAction { tap() }
    }

    private func draw(_ game: StackGame, in canvas: inout GraphicsContext, now: TimeInterval, left: CGFloat, groundY: CGFloat, screenY: (CGFloat) -> CGFloat, shown: CGFloat, height: CGFloat) {
        let h = StackGame.blockHeight
        func rect(_ block: StackGame.Block, level: Int) -> CGRect {
            CGRect(x: left + block.x, y: screenY(CGFloat(level + 1) * h), width: block.width, height: h - 1)
        }
        // The base's pedestal, down past the screen's edge.
        let base = game.tower[0]
        let pedestalTop = screenY(0)
        if pedestalTop < height {
            canvas.fill(Path(CGRect(x: left + base.x, y: pedestalTop, width: base.width, height: height - pedestalTop)), with: .color(Palette.fill))
        }
        let landing = effects.landing(at: now, reduceMotion: reduceMotion)
        for (level, block) in game.tower.enumerated() {
            var frame = rect(block, level: level)
            if level == game.tower.count - 1, landing > 0 {
                frame.origin.y -= Self.hover * landing
            }
            guard frame.maxY > -h, frame.minY < height else { continue }
            let color = level == 0 ? Palette.fillStrong : Self.color(block.tier)
            canvas.fill(Path(roundedRect: frame, cornerRadius: 4, style: .continuous), with: .color(color))
        }
        // The sliding block, one level above the tower.
        if game.phase != .over {
            let time = game.phase == .ready ? game.slide.startedAt : now
            let block = StackGame.Block(x: game.movingX(at: time), width: game.slide.width)
            let frame = rect(block, level: game.tower.count).offsetBy(dx: 0, dy: -Self.hover)
            canvas.fill(Path(roundedRect: frame, cornerRadius: 4, style: .continuous), with: .color(Self.color(.action)))
        }
        // Overhangs falling away.
        for piece in effects.falling {
            let age = now - piece.start
            guard age >= 0, age < StackEffects.fallLife else { continue }
            let t = CGFloat(age)
            // From where it slid, above its slot.
            var frame = rect(piece.block, level: piece.level).offsetBy(dx: 0, dy: -Self.hover)
            frame.origin.x += piece.drift * 40 * t
            frame.origin.y += 0.5 * 1800 * t * t
            var context = canvas
            context.opacity = 1 - Double(t) / StackEffects.fallLife
            context.translateBy(x: frame.midX, y: frame.midY)
            context.rotate(by: .degrees(Double(piece.drift) * 160 * Double(t)))
            context.fill(Path(roundedRect: CGRect(x: -frame.width / 2, y: -frame.height / 2, width: frame.width, height: frame.height), cornerRadius: 4, style: .continuous), with: .color(Self.color(piece.block.tier)))
        }
        drawMascot(game, in: &canvas, now: now, left: left, screenY: screenY, shown: shown)
    }

    /// The mascot on the tower's top, riding up as it grows.
    private func drawMascot(_ game: StackGame, in canvas: inout GraphicsContext, now: TimeInterval, left: CGFloat, screenY: (CGFloat) -> CGFloat, shown: CGFloat) {
        let width = Self.mascotWidth
        let top = game.top
        var foot = CGPoint(x: left + top.x + top.width / 2, y: screenY((shown + 1) * StackGame.blockHeight))
        var angle = 0.0
        var opacity = 1.0
        var eyes: CGFloat = 1
        if !reduceMotion && !frozen {
            if let event = effects.mascot {
                let age = now - event.start
                switch event.kind {
                case .hop where age < 0.4:
                    foot.y -= 18 * sin(.pi * age / 0.4)
                case .shake where age < 0.35:
                    foot.x += 3 * sin(age / 0.35 * 6 * .pi) * (1 - age / 0.35)
                case .tumble:
                    let t = min(age, 1.4)
                    foot.x += 70 * t
                    foot.y += -60 * t + 0.5 * 1400 * t * t
                    angle = 300 * t
                    opacity = max(0, 1 - t / 1.4)
                default:
                    break
                }
            }
            eyes = MascotPose(time: now + 1).eyeScale
        }
        guard opacity > 0 else { return }
        var context = canvas
        context.opacity = opacity
        context.translateBy(x: foot.x, y: foot.y)
        context.rotate(by: .degrees(angle))
        let scale = width / Mascot.viewBox.width
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
        face.translateBy(x: anchor.x, y: anchor.y)
        face.scaleBy(x: 1, y: eyes)
        face.translateBy(x: -anchor.x, y: -anchor.y)
        for eye in [MascotPaths.leftEye, MascotPaths.rightEye] {
            face.fill(shape(eye), with: .color(Palette.fg))
            face.stroke(shape(eye), with: .color(Palette.fg), style: StrokeStyle(lineWidth: 2, lineJoin: .round))
        }
    }

    static func color(_ tier: StackGame.Tier) -> Color {
        switch tier {
        case .action: return Palette.appTiles[1]
        case .skill: return Palette.appTiles[3]
        case .app: return Palette.primary
        }
    }

    // MARK: Parts

    private var topBar: some View {
        HStack(spacing: 10) {
            if launch.fromUpdate {
                UpdateStrip()
            }
            Spacer(minLength: 0)
            GlassCircleButton(accessibilityLabel: "Close", action: onClose) {
                Image(systemName: "xmark").romeFont(16, .semibold)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    private func hud(_ game: StackGame) -> some View {
        VStack(spacing: 4) {
            Text(verbatim: "\(game.score)")
                .romeFont(56, .bold, monospacedDigits: true)
                .foregroundStyle(Palette.fg)
                .contentTransition(.numericText())
            Text("×\(game.multiplier) · Best \(game.best)")
                .romeFont(15, .medium, monospacedDigits: true)
                .foregroundStyle(Palette.sub)
            if game.phase == .ready {
                Text("Tap to start")
                    .romeFont(17, .semibold)
                    .foregroundStyle(Palette.primaryText)
                    .padding(.top, 24)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 64)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func overCard(_ game: StackGame) -> some View {
        VStack(spacing: 6) {
            Text(game.newBest ? "New best" : "Game over")
                .romeFont(22, .semibold)
                .foregroundStyle(game.newBest ? Palette.primaryText : Palette.fg)
            Text(verbatim: "\(game.score)")
                .romeFont(48, .bold, monospacedDigits: true)
                .foregroundStyle(Palette.fg)
            Text("\(game.placed) blocks")
                .romeFont(15)
                .foregroundStyle(Palette.sub)
            VStack(spacing: 10) {
                PrimaryButton(title: "Play again", action: playAgain)
                SecondaryButton(title: "Close", action: onClose)
            }
            .padding(.top, 18)
        }
        .padding(24)
        .frame(maxWidth: Metrics.buttonWidth)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: Palette.cardShadow, radius: 24, x: 0, y: 10)
        .padding(.horizontal, 20)
        .accessibilityElement(children: .contain)
    }

    private var legend: some View {
        HStack(spacing: 16) {
            legendItem(.action, "Action")
            legendItem(.skill, "Skill")
            legendItem(.app, "App")
        }
        .padding(.bottom, 12)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func legendItem(_ tier: StackGame.Tier, _ title: LocalizedStringKey) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(Self.color(tier))
                .frame(width: 10, height: 10)
            Text(title)
                .romeFont(12)
                .foregroundStyle(Palette.sub)
        }
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
            .padding(.horizontal, 14)
            .frame(height: 32)
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
        var emphasis: Bool
        var start: TimeInterval
    }

    struct MascotEvent {
        enum Kind { case hop, shake, tumble }
        var kind: Kind
        var start: TimeInterval
    }

    static let fallLife: TimeInterval = 1.2
    static let floatLife: TimeInterval = 1.1
    static let riseTime: TimeInterval = 0.25

    private(set) var falling: [Falling] = []
    private(set) var floats: [Float] = []
    private(set) var mascot: MascotEvent?
    /// The tower's height the camera and mascot ease from and to, in levels.
    private var rise: (from: CGFloat, to: CGFloat, start: TimeInterval)

    /// Resting on a tower `level` blocks high.
    init(level: Int = 0) {
        rise = (CGFloat(level), CGFloat(level), 0)
    }

    mutating func record(_ drop: StackGame.Drop, level: Int, game: StackGame, at time: TimeInterval) {
        falling.removeAll { time - $0.start > Self.fallLife }
        floats.removeAll { time - $0.start > Self.floatLife }
        switch drop {
        case .perfect(let combo, _, let merge):
            let text = combo > 1 ? String(localized: "Perfect ×\(combo)") : String(localized: "Perfect")
            floats.append(Float(text: text, level: level, row: 0, emphasis: true, start: time))
            mascot = MascotEvent(kind: .hop, start: time)
            noteMerge(merge, level: level, row: 1, at: time)
        case .cut(let piece, _, let merge):
            let below = game.tower[level - 1]
            falling.append(Falling(block: piece, level: level, drift: piece.x < below.x ? -1 : 1, start: time))
            mascot = MascotEvent(kind: .shake, start: time)
            noteMerge(merge, level: level, row: 0, at: time)
        case .miss(let block):
            let below = game.top
            falling.append(Falling(block: block, level: level, drift: block.x < below.x ? -1 : 1, start: time))
            mascot = MascotEvent(kind: .tumble, start: time)
            return
        }
        rise = (from: CGFloat(level - 1), to: CGFloat(level), start: time)
    }

    private mutating func noteMerge(_ merge: StackGame.Merge?, level: Int, row: Int, at time: TimeInterval) {
        guard let merge else { return }
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
