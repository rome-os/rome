import CoreGraphics
import Foundation

/// "Stack up": a block slides above the tower and a tap drops it. What
/// overlaps the block below stays, the overhang falls away, and a drop
/// that misses ends the game. Pure logic: the sliding block's place is a
/// function of time, so the view only reads it and nothing ticks.
struct StackGame: Equatable {
    /// Five actions merge into a skill, five skills into an app.
    enum Tier: Equatable { case action, skill, app }

    struct Block: Equatable {
        var x: CGFloat
        var width: CGFloat
        var tier: Tier = .action

        var right: CGFloat { x + width }
    }

    enum Phase: Equatable { case ready, playing, over }

    enum Merge: Equatable { case skill, app }

    /// What a drop did.
    enum Drop: Equatable {
        /// Within the tolerance: snapped onto the block below.
        case perfect(combo: Int, points: Int, merge: Merge?)
        /// Overlapped: the overhang (`piece`) falls away.
        case cut(piece: Block, points: Int, merge: Merge?)
        /// No overlap: the whole block falls and the game is over.
        case miss(Block)
    }

    static let blockHeight: CGFloat = 22
    /// A drop this close to the block below snaps onto it.
    static let perfectTolerance: CGFloat = 5
    /// From the third perfect in a row, the block grows back this much.
    static let regrow: CGFloat = 8
    static let regrowFromCombo = 3
    /// Points per second: the start, the rise per block, the cap.
    static let startSpeed: CGFloat = 100
    static let speedStep: CGFloat = 4
    static let maxSpeed: CGFloat = 310
    /// The base is this share of the field, up to `maxBaseWidth` on an iPad.
    static let baseShare: CGFloat = 0.56
    static let maxBaseWidth: CGFloat = 240
    static let skillEvery = 5
    static let appEvery = 25

    let fieldWidth: CGFloat
    let baseWidth: CGFloat
    /// The base first; every placed block after it.
    private(set) var tower: [Block]
    private(set) var phase: Phase = .ready
    private(set) var score = 0
    /// Perfect drops in a row.
    private(set) var combo = 0
    private(set) var best: Int
    /// The game just ended above the best it started with.
    private(set) var newBest = false
    /// The sliding block's width, and where and when its slide started.
    private(set) var slide: Slide

    struct Slide: Equatable {
        var width: CGFloat
        /// Starts at the left edge going right, or the right edge going left.
        var fromLeft: Bool
        var speed: CGFloat
        var startedAt: TimeInterval
    }

    init(fieldWidth: CGFloat, best: Int = 0) {
        self.fieldWidth = fieldWidth
        let base = min((fieldWidth * Self.baseShare).rounded(), Self.maxBaseWidth)
        baseWidth = base
        tower = [Block(x: ((fieldWidth - base) / 2).rounded(), width: base)]
        self.best = best
        slide = Slide(width: base, fromLeft: true, speed: Self.startSpeed, startedAt: 0)
    }

    /// Blocks placed on the base.
    var placed: Int { tower.count - 1 }
    var top: Block { tower[tower.count - 1] }
    /// Points the next drop earns: 1, plus the combo up to four.
    var multiplier: Int { 1 + min(combo, 4) }
    var speed: CGFloat { min(Self.startSpeed + Self.speedStep * CGFloat(placed), Self.maxSpeed) }

    /// The square around the mascot where a tap starts a game.
    static let startTarget: CGFloat = 88
    /// Around the mascot's bubble, which counts as the mascot.
    static let bubblePadding: CGFloat = 12

    /// What a tap must hit to start a game: the square around the mascot
    /// (its middle at `mascot`) and its bubble, padded.
    static func startArea(mascot: CGPoint, bubble: CGRect?) -> CGRect {
        let square = CGRect(x: mascot.x - startTarget / 2, y: mascot.y - startTarget / 2, width: startTarget, height: startTarget)
        guard let bubble else { return square }
        return square.union(bubble.insetBy(dx: -bubblePadding, dy: -bubblePadding))
    }

    /// Before the start and after the end, only a tap on the mascot or its
    /// bubble (`area`) counts: it starts a game. While playing, a tap
    /// anywhere drops.
    func tapCounts(at point: CGPoint, area: CGRect) -> Bool {
        switch phase {
        case .ready, .over: return area.contains(point)
        case .playing: return true
        }
    }

    /// The first tap: the block starts to slide.
    mutating func start(at time: TimeInterval) {
        guard phase == .ready else { return }
        phase = .playing
        slide.startedAt = time
    }

    /// The sliding block's left edge at `time`: back and forth across the
    /// field, turning at each edge.
    func movingX(at time: TimeInterval) -> CGFloat {
        let span = max(fieldWidth - slide.width, 0)
        guard span > 0 else { return 0 }
        let travelled = slide.speed * CGFloat(max(time - slide.startedAt, 0)) + (slide.fromLeft ? 0 : span)
        let lap = travelled.truncatingRemainder(dividingBy: 2 * span)
        return lap <= span ? lap : 2 * span - lap
    }

    @discardableResult
    mutating func drop(at time: TimeInterval) -> Drop? {
        guard phase == .playing else { return nil }
        return drop(x: movingX(at: time), at: time)
    }

    /// Drops the sliding block with its left edge at `x`.
    @discardableResult
    mutating func drop(x: CGFloat, at time: TimeInterval) -> Drop {
        let below = top
        let width = slide.width
        let result: Drop
        if abs(x - below.x) <= Self.perfectTolerance {
            combo += 1
            var block = Block(x: below.x, width: below.width)
            if combo >= Self.regrowFromCombo, block.width < baseWidth {
                let grown = min(block.width + Self.regrow, baseWidth)
                // Grows on both sides, kept on the field.
                block.x = min(max(block.x - (grown - block.width) / 2, 0), fieldWidth - grown)
                block.width = grown
            }
            let points = multiplier
            tower.append(block)
            result = .perfect(combo: combo, points: points, merge: place(points: points))
        } else {
            let left = max(x, below.x)
            let right = min(x + width, below.right)
            guard right > left else {
                end()
                return .miss(Block(x: x, width: width))
            }
            combo = 0
            let points = multiplier
            tower.append(Block(x: left, width: right - left))
            // The overhang: on whichever side the drop went past.
            let piece = x < below.x
                ? Block(x: x, width: left - x)
                : Block(x: right, width: x + width - right)
            result = .cut(piece: piece, points: points, merge: place(points: points))
        }
        slide = Slide(width: top.width, fromLeft: placed % 2 == 0, speed: speed, startedAt: time)
        return result
    }

    /// Back to a fresh tower, keeping the best.
    mutating func restart() {
        self = StackGame(fieldWidth: fieldWidth, best: best)
    }

    /// Scores a placed block, and every fifth and twenty-fifth merges.
    private mutating func place(points: Int) -> Merge? {
        score += points
        if placed % Self.appEvery == 0 {
            recolor(last: Self.appEvery, to: .app)
            score += Self.appEvery
            return .app
        }
        if placed % Self.skillEvery == 0 {
            recolor(last: Self.skillEvery, to: .skill)
            score += Self.skillEvery
            return .skill
        }
        return nil
    }

    private mutating func recolor(last count: Int, to tier: Tier) {
        for index in max(tower.count - count, 1)..<tower.count {
            tower[index].tier = tier
        }
    }

    private mutating func end() {
        phase = .over
        if score > best {
            best = score
            newBest = true
        }
    }
}

extension StackGame {
    /// A tower part way up, for the snapshot runner: twelve blocks (two
    /// skills and two actions) after two perfects in a row; or, with
    /// `over`, a tall tower of forty (an app, then three skills) lost above
    /// `best`.
    static func sample(fieldWidth: CGFloat, best: Int, over: Bool) -> StackGame {
        var game = StackGame(fieldWidth: fieldWidth, best: best)
        game.start(at: 0)
        var offsets: [CGFloat] = [-14, 9, 0, -12, 11, 0, -8, 7, -9, 10, 0, 0]
        if over {
            let more: [CGFloat] = [0, 6, 0, 0, -6, 0]
            offsets += (0..<28).map { more[$0 % more.count] }
        }
        for (index, offset) in offsets.enumerated() {
            game.drop(x: game.top.x + offset, at: TimeInterval(index + 1))
        }
        if over {
            game.drop(x: game.top.right + 4, at: TimeInterval(offsets.count + 1))
        } else {
            // Mid-slide, to the right of the tower.
            game.slide.startedAt = 0
            game.slide.fromLeft = true
        }
        return game
    }
}

/// The best score, on this device: kept across sign-out and accounts, never
/// sent anywhere.
enum StackGameBest {
    static let key = "stackGame.best"

    static func load(_ defaults: UserDefaults = .standard) -> Int { defaults.integer(forKey: key) }

    static func save(_ score: Int, _ defaults: UserDefaults = .standard) {
        guard score > load(defaults) else { return }
        defaults.set(score, forKey: key)
    }
}

/// Ten taps in a row, each within `gap` of the last, open the game.
struct TapStreak {
    static let gap: TimeInterval = 0.6
    static let needed = 10

    private(set) var count = 0
    private var last: TimeInterval?

    /// True on the tap that completes the streak; the count starts over.
    mutating func tap(at time: TimeInterval) -> Bool {
        if let last, time - last <= Self.gap {
            count += 1
        } else {
            count = 1
        }
        last = time
        guard count >= Self.needed else { return false }
        count = 0
        self.last = nil
        return true
    }
}
