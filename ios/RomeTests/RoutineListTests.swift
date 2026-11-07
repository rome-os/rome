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

    @Test func hidesManagedRoutines() {
        let shown = RoutineList.shown([routine("mine"), routine("follow", managedBy: "concierge")])
        #expect(shown.map(\.id) == ["mine"])
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
}
