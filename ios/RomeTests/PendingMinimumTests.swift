import Foundation
import Testing
@testable import Rome

/// `Config/pending-minimum.json` holds the minimum raises iOS PRs ask for;
/// `Tools/bump-minimum.mjs` applies them before a TestFlight build. A
/// malformed entry would stop that step, so it fails here first.
@Suite struct PendingMinimumTests {
    private struct Pending: Decodable {
        struct Entry: Decodable {
            let tier: String
            let reason: String
            let pr: Int
            let server: String
        }
        let entries: [Entry]
    }

    private static let file = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Config/pending-minimum.json")

    @Test func everyPendingEntryIsWellFormed() throws {
        let pending = try JSONDecoder().decode(Pending.self, from: Data(contentsOf: Self.file))
        for entry in pending.entries {
            #expect(["background", "blocking"].contains(entry.tier), "\(entry.tier)")
            #expect(!entry.reason.trimmingCharacters(in: .whitespaces).isEmpty)
            #expect(entry.pr > 0)
            #expect(entry.server.wholeMatch(of: /#\d+|[0-9a-f]{7,40}/) != nil, "\(entry.server)")
        }
    }

    @Test func theBackgroundMinimumIsNeverBelowTheBlockingOne() {
        #expect(UpdateGate.isSupported(UpdateGate.minimumInstanceVersion, minimum: UpdateGate.blockingMinimumInstanceVersion))
    }
}
