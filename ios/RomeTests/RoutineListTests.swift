import Foundation
import Testing
@testable import Rome

@Suite struct RoutineListTests {
    private func routine(
        _ id: String,
        rrule: String? = "FREQ=DAILY",
        enabled: Bool = true,
        managedBy: String? = nil,
        fired: Bool = false,
        lastRun: String? = nil,
        type: String = "schedule"
    ) -> Routine {
        var trigger: [String: JSONValue] = ["type": .string(type), "localTime": .string("09:00")]
        if let rrule { trigger["rrule"] = .string(rrule) }
        return Routine(
            id: id, name: id, enabled: enabled, trigger: .object(trigger), nextRunAt: nil,
            managedBy: managedBy, actionName: nil,
            lastFiredAt: fired ? .string("2026-11-01T09:00:00Z") : nil,
            lastRun: lastRun.map { .init(status: $0) }
        )
    }

    @Test func hidesACompletedOneOff() {
        let done = routine("done", rrule: nil, fired: true, lastRun: "success")
        #expect(RoutineList.isCompletedOneOff(done))
        #expect(RoutineList.shown([done]).isEmpty)
    }

    @Test func keepsAOneOffThatIsStillGoingOrWaiting() {
        #expect(!RoutineList.isCompletedOneOff(routine("a", rrule: nil, fired: true, lastRun: "running")))
        #expect(!RoutineList.isCompletedOneOff(routine("b", rrule: nil, fired: true, lastRun: "pending_approval")))
        // Not fired yet, a repeating one, or not on a schedule: kept.
        #expect(!RoutineList.isCompletedOneOff(routine("c", rrule: nil, fired: false)))
        #expect(!RoutineList.isCompletedOneOff(routine("d", fired: true, lastRun: "success")))
        #expect(!RoutineList.isCompletedOneOff(routine("e", rrule: nil, fired: true, lastRun: "success", type: "event")))
    }

    @Test func aOneOffThatFailedIsDoneToo() {
        // The same rule as the dashboard: only a run still going keeps it.
        #expect(RoutineList.isCompletedOneOff(routine("f", rrule: nil, fired: true, lastRun: "error")))
    }

    private func kept(_ id: String, action: String? = nil, key: String? = nil, managedBy: String? = nil, enabled: Bool = true) -> Routine {
        Routine(id: id, name: id, enabled: enabled, trigger: .object(["type": .string("schedule"), "rrule": .string("FREQ=DAILY")]),
                nextRunAt: nil, managedBy: managedBy, key: key, actionName: action, lastFiredAt: nil, lastRun: nil)
    }

    /// As core sends them: its own routines carry no managedBy, so action and key tell.
    @Test func groupsByWhoKeepsThem() {
        #expect(RoutineList.owner(kept("mine")) == .yours)
        #expect(RoutineList.owner(kept("digest", action: "core:concierge_digest", key: "concierge-digest:guardian")) == .chat)
        #expect(RoutineList.owner(kept("follow", action: "core:concierge_follow_event")) == .chat)
        #expect(RoutineList.owner(kept("follow-key", key: "concierge-follow:gcal")) == .chat)
        #expect(RoutineList.owner(kept("system_upgrade", action: "system_upgrade")) == .system)
        #expect(RoutineList.owner(kept("app", managedBy: "dream")) == .system)
        #expect(RoutineList.owner(kept("concierge-app", managedBy: "concierge")) == .chat)

        let groups = RoutineList.groups([
            kept("system_upgrade", action: "system_upgrade"), kept("b-mine"), kept("digest", action: "core:concierge_digest"),
            kept("a-mine"), kept("paused-follow", action: "core:concierge_follow_event", enabled: false),
        ])
        #expect(groups.map(\.kind) == [.yours, .chat, .system, .paused])
        #expect(groups[0].routines.map(\.id) == ["a-mine", "b-mine"])
        #expect(groups[3].routines.map(\.id) == ["paused-follow"])
        // A list of only your own is one group, shown without a title.
        #expect(RoutineList.groups([kept("a"), kept("b")]).map(\.kind) == [.yours])
    }

    /// A long email breaks inside instead of taking a line of its own.
    @Test func longTokensCanBreakInside() {
        let title = RoutineText.breakable("Concierge follows lin.chen.workspace@example.com (Google Calendar)")
        #expect(title.contains("lin.\u{200B}chen.\u{200B}workspace@\u{200B}example.\u{200B}com"))
        #expect(RoutineText.breakable("Price watch") == "Price watch")
        #expect(title.replacingOccurrences(of: "\u{200B}", with: "") == "Concierge follows lin.chen.workspace@example.com (Google Calendar)")
    }

    @Test func keepsPausedOnesAfterActiveOnes() {
        let shown = RoutineList.shown([routine("b-paused", enabled: false), routine("c-active"), routine("a-paused", enabled: false)])
        #expect(shown.map(\.id) == ["c-active", "a-paused", "b-paused"])
    }

    @Test func keepsOnesWhoseLastRunFailed() {
        let failed = routine("failed", lastRun: "error")
        #expect(RoutineList.shown([failed]).map(\.id) == ["failed"])
        #expect(failed.lastRunFailed)
        #expect(!routine("ok", lastRun: "success").lastRunFailed)
    }

    @Test func decodesTheServerRow() throws {
        let json = #"{"id":"r","name":"r","enabled":true,"trigger":{"type":"schedule"},"managedBy":null,"lastFiredAt":"2026-11-01T09:00:00.000Z","lastRun":{"status":"error","firedAt":"2026-11-01T09:00:00.000Z"}}"#
        let decoded = try JSONDecoder().decode(Routine.self, from: Data(json.utf8))
        #expect(decoded.lastRun?.status == "error")
        #expect(decoded.lastFiredAt != nil)
        #expect(decoded.managedBy == nil)
    }

    /// Active ones first, then the paused ones in their own group, each by name.
    @Test func groupsActiveThenPaused() {
        let groups = RoutineList.groups([routine("b-paused", enabled: false), routine("c-active"), routine("a-paused", enabled: false), routine("a-active")])
        #expect(groups.map(\.kind) == [.yours, .paused])
        #expect(groups[0].routines.map(\.id) == ["a-active", "c-active"])
        #expect(groups[1].routines.map(\.id) == ["a-paused", "b-paused"])
    }
}
