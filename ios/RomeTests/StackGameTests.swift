import CoreGraphics
import Foundation
import Testing
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
}
