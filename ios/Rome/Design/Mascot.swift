import SwiftUI

/// Rome's mascot, from the web icon (`packages/web/public/icon.svg`) without
/// its white backdrop: a head with a screen for a face, two eyes, a body. The
/// head and body take the foreground color, the screen the page color. The
/// launch image (`LaunchLogo`) is drawn from the same paths at the same size.
struct Mascot: View {
    /// Blinks, glances and nods while something loads.
    var alive = false
    /// Still, but blinks now and then (the sign-in page).
    var blinks = false
    /// Counts taps: each new one plays the next reaction, cutting off the last.
    var pokes = 0

    /// The paths' own size; the launch image uses it too.
    static let viewBox = MascotPaths.viewBox
    /// The width the opening and launch screens draw it at.
    static let width: CGFloat = 96

    /// Seconds between blinks when it only blinks.
    static let blinkEvery: Duration = .seconds(4.5)

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.offScreen) private var offScreen
    @State private var eyesClosed = false
    @State private var reaction: MascotPose = .rest
    @State private var squash: CGFloat = 1
    @State private var reacting: Task<Void, Never>?

    /// Still with Reduce Motion, and in snapshot runs.
    private var canMove: Bool {
        #if DEBUG
        if SnapshotRunner.directory != nil { return false }
        #endif
        return !reduceMotion
    }

    var body: some View {
        Group {
            if alive && canMove {
                // While something loads: frames at a modest rate, the paths parsed once.
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: offScreen)) { context in
                    let _ = PerfProbe.count("mascotTick")
                    figure(MascotPose(time: context.date.timeIntervalSinceReferenceDate))
                }
            } else {
                // Still between blinks and reactions: nothing redraws until the next one.
                figure(eyesClosed ? .blink : reaction)
                    .scaleEffect(squash, anchor: .bottom)
                    .onChange(of: pokes) { react(to: pokes) }
                    .task(id: blinks && canMove) {
                        guard blinks && canMove else { return }
                        while !Task.isCancelled {
                            try? await Task.sleep(for: Self.blinkEvery)
                            guard !Task.isCancelled else { return }
                            withAnimation(.easeIn(duration: 0.09)) { eyesClosed = true }
                            try? await Task.sleep(for: .milliseconds(90))
                            withAnimation(.easeOut(duration: 0.09)) { eyesClosed = false }
                        }
                    }
            }
        }
        .aspectRatio(Self.viewBox, contentMode: .fit)
        .accessibilityHidden(true)
    }

    /// A tap: a squash and bounce with the next reaction, or with Reduce
    /// Motion just a blink. A new tap starts over from rest.
    private func react(to count: Int) {
        reacting?.cancel()
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            reaction = .rest
            squash = 1
        }
        let kind = MascotReaction.forTap(count, reduceMotion: !canMove)
        reacting = Task { @MainActor in
            if canMove {
                withAnimation(.easeOut(duration: 0.08)) { squash = 0.9 }
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled else { return }
                // Springs past full size and settles: the bounce.
                withAnimation(.spring(response: 0.22, dampingFraction: 0.45)) { squash = 1 }
            }
            for (pose, duration) in kind.steps {
                withAnimation(.easeInOut(duration: duration)) { reaction = pose }
                try? await Task.sleep(for: .seconds(duration))
                guard !Task.isCancelled else { return }
            }
            withAnimation(.easeOut(duration: 0.1)) { reaction = .rest }
        }
    }

    private func figure(_ pose: MascotPose) -> some View {
        GeometryReader { geometry in
            let scale = geometry.size.width / Self.viewBox.width
            ZStack {
                SVGShape(MascotPaths.body, viewBox: Self.viewBox).fill(Palette.fg)
                ZStack {
                    SVGShape(MascotPaths.headFill, viewBox: Self.viewBox).fill(Palette.fg)
                    SVGShape(MascotPaths.headRing, viewBox: Self.viewBox).fill(Palette.fg)
                    SVGShape(MascotPaths.screen, viewBox: Self.viewBox).fill(Palette.bg)
                    SVGShape(MascotPaths.screen, viewBox: Self.viewBox)
                        .stroke(Palette.fg, style: StrokeStyle(lineWidth: 4 * scale, lineCap: .round, lineJoin: .round))
                    ZStack {
                        eye(MascotPaths.leftEye, scale: scale)
                        eye(MascotPaths.rightEye, scale: scale)
                            .scaleEffect(x: 1, y: pose.rightEyeScale, anchor: MascotPaths.eyeAnchor)
                    }
                    .scaleEffect(x: 1, y: pose.eyeScale, anchor: MascotPaths.eyeAnchor)
                    .offset(x: pose.glance * scale)
                }
                .rotationEffect(.degrees(pose.tilt), anchor: MascotPaths.neckAnchor)
                .offset(y: pose.nod * scale)
            }
        }
    }

    private func eye(_ path: String, scale: CGFloat) -> some View {
        ZStack {
            SVGShape(path, viewBox: Self.viewBox).fill(Palette.fg)
            SVGShape(path, viewBox: Self.viewBox)
                .stroke(Palette.fg, style: StrokeStyle(lineWidth: 2 * scale, lineJoin: .round))
        }
    }
}

/// Where the mascot's eyes and head are at a moment, in the paths' units.
struct MascotPose: Equatable {
    var eyeScale: CGFloat = 1
    /// The right eye alone, for a wink.
    var rightEyeScale: CGFloat = 1
    var glance: CGFloat = 0
    var nod: CGFloat = 0
    var tilt: Double = 0

    static let rest = MascotPose()

    /// A blink every 3.6 s (0.18 s long), a slow glance left and right, and a
    /// gentle nod.
    init(time: TimeInterval) {
        let blinkEvery = 3.6, blinkLength = 0.18
        let intoBlink = time.truncatingRemainder(dividingBy: blinkEvery)
        if intoBlink < blinkLength {
            eyeScale = 1 - 0.92 * sin(.pi * intoBlink / blinkLength)
        }
        glance = 1.6 * sin(2 * .pi * time / 6.5)
        nod = 0.9 * sin(2 * .pi * time / 2.4)
        tilt = 1.4 * sin(2 * .pi * time / 2.4 + 0.6)
    }

    /// The eyes shut, the rest still: the middle of a blink.
    static let blink = MascotPose(eyeScale: 0.08)

    init(eyeScale: CGFloat = 1, rightEyeScale: CGFloat = 1, glance: CGFloat = 0, nod: CGFloat = 0, tilt: Double = 0) {
        self.eyeScale = eyeScale
        self.rightEyeScale = rightEyeScale
        self.glance = glance
        self.nod = nod
        self.tilt = tilt
    }
}

/// What a tap on the mascot plays, in turn.
enum MascotReaction: CaseIterable, Equatable {
    case blink, wink, glance, nod

    /// The `count`th tap's reaction, cycling; with Reduce Motion always a blink.
    static func forTap(_ count: Int, reduceMotion: Bool) -> MascotReaction {
        guard !reduceMotion, count > 0 else { return .blink }
        return allCases[(count - 1) % allCases.count]
    }

    /// The poses it passes through and how long each takes, about 0.3 s in all.
    var steps: [(MascotPose, Double)] {
        switch self {
        case .blink: return [(.blink, 0.09), (.rest, 0.09)]
        case .wink: return [(MascotPose(rightEyeScale: 0.08), 0.12), (.rest, 0.12)]
        case .glance: return [(MascotPose(glance: -2), 0.1), (MascotPose(glance: 2), 0.12), (.rest, 0.1)]
        case .nod: return [(MascotPose(nod: 1.6, tilt: 3), 0.12), (MascotPose(nod: -0.4, tilt: -1), 0.1), (.rest, 0.1)]
        }
    }
}
