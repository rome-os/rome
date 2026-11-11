import CoreGraphics
import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Rome

@Suite struct StackGameTests {
    /// A 400 pt field: the base is 224 pt wide, at x 88.
    private func playing(best: Int = 0) -> StackGame {
        var game = StackGame(fieldWidth: 400, best: best)
        game.start(at: 0)
        return game
    }

    @Test func theBaseIsAShareOfTheFieldCappedOnAWideScreen() {
        let phone = StackGame(fieldWidth: 400)
        #expect(phone.baseWidth == 224)
        #expect(phone.top.x == 88)
        #expect(StackGame(fieldWidth: 1000).baseWidth == StackGame.maxBaseWidth)
    }

    @Test func theBlockSlidesAndTurnsAtTheEdges() {
        var game = StackGame(fieldWidth: 400)
        game.start(at: 10)
        #expect(game.movingX(at: 11) == 100)
        // 176 pt of travel: at the right edge after 1.76 s, then back.
        #expect(abs(game.movingX(at: 11.76) - 176) < 0.001)
        #expect(abs(game.movingX(at: 12.76) - 76) < 0.001)
    }

    @Test func anOverhangIsCutOffAndFalls() {
        var game = playing()
        let drop = game.drop(x: 108, at: 1)
        #expect(game.top == StackGame.Block(x: 108, width: 204))
        #expect(drop == .cut(piece: StackGame.Block(x: 312, width: 20), points: 1, merge: nil))
        // To the left: the piece is the left part.
        let left = game.drop(x: 100, at: 2)
        #expect(game.top == StackGame.Block(x: 108, width: 196))
        #expect(left == .cut(piece: StackGame.Block(x: 100, width: 8), points: 1, merge: nil))
        #expect(game.score == 2)
    }

    @Test func aDropWithinFivePointsSnapsExactly() {
        var game = playing()
        let drop = game.drop(x: 93, at: 1)
        #expect(game.top == StackGame.Block(x: 88, width: 224))
        #expect(drop == .perfect(combo: 1, points: 2, merge: nil))
        let next = game.drop(x: 82.5, at: 2)
        #expect(next == .cut(piece: StackGame.Block(x: 82.5, width: 5.5), points: 1, merge: nil))
    }

    @Test func perfectsInARowRaiseTheMultiplierUpToFive() {
        var game = playing()
        var points: [Int] = []
        for index in 0..<6 {
            if case .perfect(_, let earned, _) = game.drop(x: game.top.x, at: TimeInterval(index + 1)) { points.append(earned) }
        }
        // The fifth block also merges into a skill.
        #expect(points == [2, 3, 4, 5, 5, 5])
        #expect(game.multiplier == 5)
        // A miss of the snap resets the combo.
        game.drop(x: game.top.x + 20, at: 10)
        #expect(game.combo == 0)
        #expect(game.multiplier == 1)
    }

    @Test func fromTheThirdPerfectTheBlockGrowsBack() {
        var game = playing()
        game.drop(x: 128, at: 1)
        #expect(game.top.width == 184)
        game.drop(x: game.top.x, at: 2)
        game.drop(x: game.top.x, at: 3)
        #expect(game.top.width == 184)
        game.drop(x: game.top.x, at: 4)
        #expect(game.top == StackGame.Block(x: 124, width: 192))
        // Never past the base.
        for index in 0..<10 { game.drop(x: game.top.x, at: TimeInterval(5 + index)) }
        #expect(game.top.width == 224)
    }

    @Test func everyFifthBlockMergesIntoASkillAndEveryTwentyFifthIntoAnApp() {
        var game = playing()
        var merges: [StackGame.Merge] = []
        for index in 0..<25 {
            // Off by 6 every time: no combo, a point a block.
            switch game.drop(x: game.top.x + (index % 2 == 0 ? 6 : -6), at: TimeInterval(index + 1)) {
            case .cut(_, _, let merge?), .perfect(_, _, let merge?): merges.append(merge)
            default: break
            }
            if index == 4 {
                #expect(game.tower[1...5].allSatisfy { $0.tier == .skill })
                #expect(game.score == 5 + 5)
            }
            if index == 5 { #expect(game.top.tier == .action) }
        }
        #expect(merges == [.skill, .skill, .skill, .skill, .app])
        #expect(game.tower[1...25].allSatisfy { $0.tier == .app })
        #expect(game.tower[0].tier == .action)
        // 25 blocks, four skills, one app.
        #expect(game.score == 25 + 4 * 5 + 25)
    }

    @Test func noOverlapEndsTheGame() {
        var game = playing()
        let drop = game.drop(x: 312, at: 1)
        #expect(drop == .miss(StackGame.Block(x: 312, width: 224)))
        #expect(game.phase == .over)
        #expect(game.placed == 0)
        let after = game.drop(at: 2)
        #expect(after == nil)
    }

    @Test func aScoreAboveTheBestIsANewBest() {
        var game = playing(best: 1)
        game.drop(x: 88, at: 1)
        game.drop(x: 400, at: 2)
        #expect(game.best == 2)
        #expect(game.newBest)
        // Not above it: the best stays.
        var lower = playing(best: 9)
        lower.drop(x: 88, at: 1)
        lower.drop(x: 400, at: 2)
        #expect(lower.best == 9)
        #expect(!lower.newBest)
        lower.restart()
        #expect(lower.phase == .ready && lower.score == 0 && lower.best == 9)
    }

    @Test func speedRisesWithHeightUpToTheCap() {
        var game = playing()
        #expect(game.speed == 100)
        for index in 0..<10 { game.drop(x: game.top.x, at: TimeInterval(index + 1)) }
        #expect(game.speed == 140)
        #expect(game.slide.speed == 140)
        for index in 0..<60 { game.drop(x: game.top.x, at: TimeInterval(index + 20)) }
        #expect(game.speed == StackGame.maxSpeed)
    }

    @Test func theBestIsKeptOnlyWhenHigher() throws {
        let defaults = try #require(UserDefaults(suiteName: "StackGameTests"))
        defaults.removePersistentDomain(forName: "StackGameTests")
        StackGameBest.save(12, defaults)
        StackGameBest.save(7, defaults)
        #expect(StackGameBest.load(defaults) == 12)
        defaults.removePersistentDomain(forName: "StackGameTests")
    }

    @Test func onlyATapOnTheMascotStartsOrPlaysAgain() {
        var game = StackGame(fieldWidth: 400)
        let area = StackGame.startArea(mascot: CGPoint(x: 200, y: 600), bubble: nil)
        #expect(game.tapCounts(at: CGPoint(x: 240, y: 560), area: area))
        #expect(!game.tapCounts(at: CGPoint(x: 250, y: 600), area: area))
        #expect(!game.tapCounts(at: CGPoint(x: 200, y: 300), area: area))
        // Playing, a tap anywhere drops.
        game.start(at: 0)
        #expect(game.tapCounts(at: CGPoint(x: 10, y: 10), area: area))
        game.drop(x: 400, at: 1)
        // Over: only the mascot, now lying beside the base, plays again.
        let lying = StackGame.startArea(mascot: CGPoint(x: 340, y: 660), bubble: nil)
        #expect(game.tapCounts(at: CGPoint(x: 360, y: 640), area: lying))
        #expect(!game.tapCounts(at: CGPoint(x: 200, y: 400), area: lying))
    }

    @Test func theBubbleCountsAsTheMascot() {
        let game = StackGame(fieldWidth: 400)
        // "Play again" runs right from the mascot, past its square.
        let bubble = CGRect(x: 300, y: 580, width: 130, height: 44)
        let area = StackGame.startArea(mascot: CGPoint(x: 320, y: 650), bubble: bubble)
        #expect(game.tapCounts(at: CGPoint(x: 420, y: 600), area: area))
        // Its padding counts too, and nothing past it.
        #expect(game.tapCounts(at: CGPoint(x: 438, y: 600), area: area))
        #expect(!game.tapCounts(at: CGPoint(x: 445, y: 600), area: area))
        #expect(!game.tapCounts(at: CGPoint(x: 400, y: 540), area: area))
    }

    @Test func theEndSampleIsATallLostTower() {
        let game = StackGame.sample(fieldWidth: 393, best: 24, over: true)
        #expect(game.phase == .over)
        #expect(game.placed == 40)
        #expect(game.newBest)
        #expect(game.tower[1...25].allSatisfy { $0.tier == .app })
        #expect(game.tower[26...40].allSatisfy { $0.tier == .skill })
    }

    @Test func tenQuickTapsOpenTheGame() {
        var streak = TapStreak()
        var opened: [Int] = []
        for index in 0..<20 where streak.tap(at: Double(index) * 0.4) { opened.append(index) }
        #expect(opened == [9, 19])
    }

    @Test func aSlowTapStartsTheCountOver() {
        var streak = TapStreak()
        for index in 0..<9 {
            let opened = streak.tap(at: Double(index) * 0.5)
            #expect(!opened)
        }
        // 0.7 s after the ninth: this is the first of a new streak.
        let restarted = streak.tap(at: 4.7)
        #expect(!restarted)
        #expect(streak.count == 1)
        for index in 1..<9 {
            let opened = streak.tap(at: 4.7 + Double(index) * 0.55)
            #expect(!opened)
        }
        let opened = streak.tap(at: 4.7 + 9 * 0.55)
        #expect(opened)
    }

    @Test func aNarrowerWindowScalesTheTowerAroundTheMiddle() {
        var game = playing()
        game.drop(x: 108, at: 1)
        // 400 → 300: the base goes from 224 to 168, a scale of 0.75.
        game.resize(to: 300)
        #expect(game.fieldWidth == 300)
        #expect(game.baseWidth == 168)
        #expect(game.tower[0] == StackGame.Block(x: 66, width: 168))
        // The placed block kept its offset from the middle, scaled: 210 → 157.5.
        #expect(abs(game.top.x + game.top.width / 2 - 157.5) < 0.001)
        #expect(abs(game.top.width - 153) < 0.001)
        #expect(abs(game.slide.width - 153) < 0.001)
        // The slider stays within the field.
        for step in 0..<40 {
            let x = game.movingX(at: 1 + Double(step) * 0.13)
            #expect(x >= 0 && x + game.slide.width <= 300 + 0.001)
        }
        // A new game starts at the new width.
        game.drop(x: 0, at: 9)
        game.restart()
        #expect(game.fieldWidth == 300 && game.baseWidth == 168)
    }

    @Test func beforeTheFirstTapAResizeStartsOver() {
        var game = StackGame(fieldWidth: 400, best: 7)
        game.resize(to: 1000)
        #expect(game == StackGame(fieldWidth: 1000, best: 7))
        // An ended game keeps its tower and result.
        var lost = playing()
        lost.drop(x: 88, at: 1)
        lost.drop(x: 400, at: 2)
        lost.resize(to: 600)
        #expect(lost.phase == .over && lost.placed == 1 && lost.score == 2)
        #expect(lost.baseWidth == StackGame.maxBaseWidth)
    }

    @Test func nothingRedrawsOnceTheEffectsEnd() {
        var effects = StackEffects()
        #expect(effects.busyUntil(playing: false, endLife: 1.5) == -.infinity)
        #expect(effects.busyUntil(playing: true, endLife: 1.5) == .infinity)
        // A cut at 2 s: the falling piece is the last thing moving.
        var game = playing()
        let level = game.tower.count
        let drop = game.drop(x: 108, at: 2)
        effects.record(drop, level: level, game: game, at: 2)
        #expect(effects.busyUntil(playing: false, endLife: 1.5) == 2 + StackEffects.fallLife)
        // A miss at 5 s: the end's motion runs past it.
        let missLevel = game.tower.count
        let miss = game.drop(x: 400, at: 5)
        effects.record(miss, level: missLevel, game: game, at: 5)
        #expect(effects.busyUntil(playing: false, endLife: 1.5) == 5 + max(1.5, StackEffects.fallLife))
    }

    @Test func theIdleFaceChangesOnlyAtItsSteps() {
        #expect(abs(StackFace.nextChange(after: 0) - 0.15) < 0.0001)
        #expect(abs(StackFace.nextChange(after: 0.15) - 1.8) < 0.0001)
        #expect(abs(StackFace.nextChange(after: 1.8) - 3.6) < 0.0001)
        #expect(abs(StackFace.nextChange(after: 3.6) - 3.75) < 0.0001)
        // Between two steps the face is the same.
        #expect(StackFace.eyes(at: 0.2) == StackFace.eyes(at: 1.7))
        #expect(StackFace.glance(at: 0.2) == StackFace.glance(at: 1.7))
        #expect(StackFace.eyes(at: 3.65) < 1)
        #expect(StackFace.glance(at: 2) != StackFace.glance(at: 0))
    }
}

/// A closed game costs the app nothing: its screen, with its timeline,
/// haptic generators and drawing, goes when the cover goes.
@MainActor
@Suite struct StackGameLifecycleTests {
    @Test func aClosedGameIsFreed() async throws {
        weak var closedHost: UIViewController?
        weak var closedView: UIView?
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        do {
            let host = UIHostingController(rootView: StackGameScreen(launch: StackGameLaunch(), onClose: {}).environment(AppModel()))
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
            window.rootViewController = host
            window.isHidden = false
            host.view.layoutIfNeeded()
            // Open long enough for the timeline to run and the art to draw.
            try await Task.sleep(for: .milliseconds(500))
            closedHost = host
            closedView = host.view
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
        }
        // UIKit lets go on a later turn of the run loop, later still on a busy
        // simulator: wait for it, up to a bound.
        for _ in 0..<50 where closedHost != nil || closedView != nil {
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(closedHost == nil)
        #expect(closedView == nil)
    }
}

/// The game's update strip says the release was reached only when the
/// updater confirmed it, never for the release it asked for.
@Suite struct UpdateStripTests {
    private let updating = InstanceUpdater.State.updating(target: "1.2.0", since: .now)

    private func run(_ steps: [(InstanceUpdater.State, String?)]) -> UpdateStripTracker {
        var tracker = UpdateStripTracker()
        for (state, updatedTo) in steps { tracker.observe(state, updatedTo: updatedTo) }
        return tracker
    }

    @Test func aFinishedUpgradeIsReached() {
        let tracker = run([(.starting(current: "1.1.0", latest: "1.2.0"), nil), (updating, nil), (.upToDate, "1.2.0")])
        #expect(tracker.line(for: .upToDate) == .reached("1.2.0"))
        // The chat clearing what it said does not take it back.
        #expect(tracker.line(for: .upToDate) == .reached("1.2.0"))
    }

    @Test func aTimedOutUpgradeSaysSoAndCanStillFinish() {
        var tracker = run([(updating, nil), (.failed(.timedOut(target: "1.2.0")), nil)])
        #expect(tracker.line(for: .failed(.timedOut(target: "1.2.0"))) == .tookTooLong)
        tracker.observe(.upToDate, updatedTo: "1.2.0")
        #expect(tracker.line(for: .upToDate) == .reached("1.2.0"))
    }

    @Test func aDismissedFailureIsNotASuccess() {
        let failure = InstanceUpdater.State.failed(.start(current: "1.1.0", latest: "1.2.0", message: "x"))
        let tracker = run([(.starting(current: "1.1.0", latest: "1.2.0"), nil), (failure, nil), (.required(current: "1.1.0", latest: "1.2.0", latestChanged: false), nil)])
        #expect(tracker.line(for: failure) == .couldNotStart)
        #expect(tracker.line(for: .required(current: "1.1.0", latest: "1.2.0", latestChanged: false)) == .none)
        // A timed-out failure closed from the page goes back to being offered.
        let closed = run([(updating, nil), (.failed(.timedOut(target: "1.2.0")), nil), (.required(current: "1.1.0", latest: "1.2.0", latestChanged: false), nil), (.upToDate, nil)])
        #expect(closed.line(for: .upToDate) == .none)
    }

    @Test func aTargetThatMovedOnIsNotASuccess() {
        // Moved on: idle, then the check that follows finds it current.
        let tracker = run([(updating, nil), (.idle, nil), (.upToDate, nil)])
        #expect(tracker.line(for: .idle) == .none)
        #expect(tracker.line(for: .upToDate) == .none)
    }

    @Test func aStaleVerdictIsNotASuccess() {
        // A newer release replaced the target, or the check says current
        // without the updater finishing.
        let newer = run([(updating, nil), (.required(current: "1.1.0", latest: "1.3.0", latestChanged: true), nil)])
        #expect(newer.line(for: .required(current: "1.1.0", latest: "1.3.0", latestChanged: true)) == .none)
        let current = run([(updating, nil), (.upToDate, nil)])
        #expect(current.line(for: .upToDate) == .none)
    }

    @Test func anEarlierUpgradesLineIsNotThisOnes() {
        // Opened with an older "updated" still unsaid, and nothing under way.
        let tracker = run([(.upToDate, "1.1.0")])
        #expect(tracker.line(for: .upToDate) == .none)
    }
}
