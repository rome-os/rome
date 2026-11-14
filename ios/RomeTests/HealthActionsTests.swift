import Foundation
import HealthKit
import SwiftUI
import Testing
@testable import Rome

/// A Health that answers from what a test puts in it, and remembers what it was asked.
final class FakeHealth: HealthReading, @unchecked Sendable {
    var available = true
    var accessError: HealthReadError?
    /// True until iOS has been asked, as on a fresh install.
    var neverAsked = false
    var quantities: [String: [Double?]] = [:]
    var segmentsByType: [String: [HealthSegment]] = [:]
    var workoutRecords: [WorkoutRecord] = []
    var sampleStore: [HealthSample] = []

    private(set) var accessRequests = 0
    private(set) var quantityRequests: [QuantityRequest] = []
    private(set) var workoutActivities: [String?] = []
    private(set) var sampleRequests: [SampleRequest] = []
    private(set) var reads = 0

    var isAvailable: Bool { available }

    func requestAccess() async throws {
        accessRequests += 1
        if let accessError { throw accessError }
        neverAsked = false
    }

    func shouldRequestAccess() async -> Bool { neverAsked }

    /// Set, every quantity read waits here until it opens: a read still under way.
    var gate: ReadGate?

    func quantityStats(_ request: QuantityRequest) async throws -> [Double?] {
        reads += 1
        if let gate { await gate.wait() }
        quantityRequests.append(request)
        return quantities[request.type.name] ?? Array(repeating: nil, count: request.buckets.count)
    }

    func segments(_ type: HealthType, in window: DateInterval) async throws -> [HealthSegment] {
        reads += 1
        return (segmentsByType[type.name] ?? []).filter { $0.end > window.start && $0.start < window.end }
    }

    func workouts(in window: DateInterval, activity: String?) async throws -> [WorkoutRecord] {
        reads += 1
        workoutActivities.append(activity)
        return workoutRecords.filter { $0.end > window.start && $0.start < window.end && (activity == nil || $0.activity == activity) }
    }

    func samples(_ request: SampleRequest) async throws -> [HealthSample] {
        reads += 1
        sampleRequests.append(request)
        var found = sampleStore.enumerated().filter { _, sample in
            sample.end >= request.window.start && sample.start < request.window.end
                && (request.sources.isEmpty || request.sources.contains(sample.source.name) || request.sources.contains(sample.source.bundleId))
        }
        if let bound = request.startBound {
            found = found.filter { request.ascending ? SampleCursor.milliseconds($0.element.start) >= bound : SampleCursor.milliseconds($0.element.start) <= bound }
        }
        found.sort { a, b in
            let (x, y) = (a.element.start, b.element.start)
            if x != y { return request.ascending ? x < y : x > y }
            return request.ascending ? a.offset < b.offset : a.offset > b.offset
        }
        return found.prefix(request.limit).map(\.element)
    }
}

/// Holds back whoever waits on it until it opens.
actor ReadGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// How many wait now.
    var waiting: Int { waiters.count }

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

enum HealthFixtures {
    /// 2026-11-09 18:30 in Shanghai, 02:30 in Los Angeles.
    static let now = date("2026-11-09T10:30:00Z")

    static func date(_ text: String) -> Date { RomeDate.parse(text)! }

    static func calendar(_ zone: String, _ identifier: Calendar.Identifier = .gregorian) -> Calendar {
        var calendar = Calendar(identifier: identifier)
        calendar.timeZone = TimeZone(identifier: zone)!
        calendar.firstWeekday = 2
        return calendar
    }

    static func actions(_ reader: HealthReading, zone: String = "Asia/Shanghai", calendar identifier: Calendar.Identifier = .gregorian) -> HealthActions {
        let calendar = calendar(zone, identifier)
        return HealthActions(reader: reader, now: { now }, calendar: { calendar })
    }

    static func ok(_ result: NodeActionResult) throws -> JSONValue {
        guard case .ok(let value, _) = result else { throw Failure(result) }
        return value
    }

    static func code(_ result: NodeActionResult) -> String? {
        if case .failed(let code, _) = result { return code }
        return nil
    }

    struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ result: NodeActionResult) { description = "unexpected \(result)" }
    }

    static func sample(_ id: String, _ start: String, value: Double? = nil, category: String? = nil, source: String = "Watch") -> HealthSample {
        let from = date(start)
        return HealthSample(
            id: id, start: from, end: from.addingTimeInterval(60), value: value, category: category,
            source: HealthSource(name: source, bundleId: "com.example.\(source.lowercased())")
        )
    }
}

@Suite struct HealthTypeTableTests {
    @Test func namesAreUniqueAndTwentyEight() {
        #expect(HealthTypes.all.count == 28)
        #expect(Set(HealthTypes.all.map(\.name)).count == 28)
    }

    @Test func everyQuantityTypeIsHealthKitsAndItsUnitsFit() throws {
        for type in HealthTypes.all where type.isQuantity {
            let quantityType = try #require(LiveHealth.quantityType(type), "\(type.name)")
            #expect(!type.units.isEmpty)
            for unit in type.units {
                #expect(quantityType.is(compatibleWith: HKUnit(from: unit.hk)), "\(type.name) \(unit.name)")
            }
            let cumulative = quantityType.aggregationStyle == .cumulative
            #expect(type.isCumulative == cumulative, "\(type.name) aggregation")
        }
    }

    @Test func everyReadTypeIsAskedForOnce() {
        #expect(LiveHealth.readTypes.count == 28)
    }

    @Test func everyActivityNameHasHealthKitsType() {
        for name in WorkoutActivities.names { #expect(LiveHealth.activityTypes[name]?.isEmpty == false, "\(name)") }
        #expect(Set(WorkoutActivities.names) == Set(LiveHealth.activityTypes.keys))
    }

    @Test func danceMeansBothOfHealthKitsDanceTypes() throws {
        #expect(LiveHealth.activityTypes["dance"] == [.socialDance, .cardioDance])
        #expect(LiveHealth.activityName(.socialDance) == "dance")
        #expect(LiveHealth.activityName(.cardioDance) == "dance")
        let predicate = try #require(LiveHealth.activityPredicate("dance") as? NSCompoundPredicate)
        #expect(predicate.compoundPredicateType == .or)
        #expect(predicate.subpredicates.count == 2, "a workout of either type matches")
        #expect(LiveHealth.activityPredicate("running") != nil)
        #expect(LiveHealth.activityPredicate("quidditch") == nil)
    }

    @Test func everyHealthKitTypeNamesItsActivityBack() {
        for (name, types) in LiveHealth.activityTypes {
            for type in types { #expect(LiveHealth.activityName(type) == name, "\(name)") }
        }
        #expect(LiveHealth.activityName(.fencing) == "other", "a kind outside the list reads as other")
    }

    @Test func sleepAnalysisIsAnAliasOfSleep() {
        #expect(HealthTypes.named("sleepAnalysis")?.name == "sleep")
        #expect(HealthTypes.named("workout")?.name == "workouts")
        #expect(HealthTypes.named("bloodType") == nil)
    }
}

@Suite struct HealthArgumentTests {
    @Test func theWindowDefaultsToTodayInThePhonesTimeZone() async throws {
        let health = FakeHealth()
        let shanghai = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#)))
        #expect(shanghai["startISO"]?.string == "2026-11-09T00:00:00+08:00")
        #expect(shanghai["endISO"]?.string == "2026-11-09T18:30:00+08:00")
        #expect(shanghai["timeZoneIdentifier"]?.string == "Asia/Shanghai")
        let angeles = try HealthFixtures.ok(await HealthFixtures.actions(health, zone: "America/Los_Angeles").run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#)))
        #expect(angeles["startISO"]?.string == "2026-11-09T00:00:00-08:00")
        #expect(angeles["endISO"]?.string == "2026-11-09T02:30:00-08:00")
        #expect(angeles["timeZoneIdentifier"]?.string == "America/Los_Angeles")
    }

    @Test func datesAreReadInThePhonesTimeZoneAndAnEndDateMeansTheEndOfThatDay() async throws {
        let health = FakeHealth()
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-11-01","end":"2026-11-03"}"#)))
        #expect(reply["startISO"]?.string == "2026-11-01T00:00:00+08:00")
        #expect(reply["endISO"]?.string == "2026-11-04T00:00:00+08:00")
        let request = try #require(health.quantityRequests.first)
        #expect(request.window.start == HealthFixtures.date("2026-10-31T16:00:00Z"))
        #expect(request.window.end == HealthFixtures.date("2026-11-03T16:00:00Z"))
    }

    @Test func instantsKeepTheirMoment() async throws {
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(FakeHealth()).run("health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-11-09T01:00:00Z","end":"2026-11-09T05:00:00+02:00"}"#)))
        #expect(reply["startISO"]?.string == "2026-11-09T09:00:00+08:00")
        #expect(reply["endISO"]?.string == "2026-11-09T11:00:00+08:00")
    }

    @Test func timesWithoutAnOffsetAreReadInThePhonesTimeZone() async throws {
        let actions = HealthFixtures.actions(FakeHealth())
        let cases = [
            ("2026-11-08T18:00", "2026-11-09T12:00", "2026-11-08T18:00:00+08:00", "2026-11-09T12:00:00+08:00"),
            ("2026-11-08T18:00:30", "2026-11-09T12:00:45", "2026-11-08T18:00:30+08:00", "2026-11-09T12:00:45+08:00"),
            ("2026-11-08T18:00:30.250", "2026-11-09T12:00:00.750", "2026-11-08T18:00:30+08:00", "2026-11-09T12:00:00+08:00"),
        ]
        for (start, end, startISO, endISO) in cases {
            let reply = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"sleep","start":"\#(start)","end":"\#(end)"}"#)))
            #expect(reply["startISO"]?.string == startISO, "\(start)")
            #expect(reply["endISO"]?.string == endISO, "\(end)")
            #expect(reply["timeZoneIdentifier"]?.string == "Asia/Shanghai")
        }
    }

    @Test func timesWithAndWithoutAnOffsetMeanTheirOwnMoment() {
        let shanghai = HealthFixtures.calendar("Asia/Shanghai")
        let angeles = HealthFixtures.calendar("America/Los_Angeles")
        #expect(HealthDates.parse("2026-11-08T18:00", endOfDay: false, calendar: shanghai) == HealthFixtures.date("2026-11-08T10:00:00Z"))
        #expect(HealthDates.parse("2026-11-08T18:00", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-11-09T02:00:00Z"))
        #expect(HealthDates.parse("2026-11-08T18:00:00Z", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-11-08T18:00:00Z"))
        #expect(HealthDates.parse("2026-11-08T18:00:00+02:00", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-11-08T16:00:00Z"))
        #expect(HealthDates.parse("2026-11-08T18:00:00.5Z", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-11-08T18:00:00Z").addingTimeInterval(0.5))
        let fraction = HealthDates.parse("2026-11-08T18:00:30.250", endOfDay: true, calendar: shanghai)
        #expect(fraction == HealthFixtures.date("2026-11-08T10:00:30Z").addingTimeInterval(0.25), "a time is a moment: endOfDay does not move it")
    }

    @Test func badLocalTimesAreRefused() {
        let calendar = HealthFixtures.calendar("Asia/Shanghai")
        for text in ["2026-11-08T24:00", "2026-11-08T18:60", "2026-11-08T18:00:60", "2026-02-30T10:00", "2026-13-01T10:00", "2026-11-08T1800", "2026-11-08T18", "2026-11-08 18:00", "2026-11-08T18:00:00.", "2026-11-08T18:00+", "T18:00"] {
            #expect(HealthDates.parse(text, endOfDay: false, calendar: calendar) == nil, "\(text)")
        }
    }

    @Test func localTimesAcrossDaylightSavingKeepTheirMeaning() throws {
        let angeles = HealthFixtures.calendar("America/Los_Angeles")
        // Spring forward, 8 March 2026: 02:00 became 03:00.
        #expect(HealthDates.parse("2026-03-08T01:30", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-03-08T09:30:00Z"))
        #expect(HealthDates.parse("2026-03-08T03:30", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-03-08T10:30:00Z"))
        // A time that never happened still parses, at or after the jump.
        let gap = try #require(HealthDates.parse("2026-03-08T02:30", endOfDay: false, calendar: angeles))
        #expect(gap >= HealthFixtures.date("2026-03-08T10:00:00Z") && gap <= HealthFixtures.date("2026-03-08T10:30:00Z"))
        // Fall back, 1 November 2026: 01:30 happens twice; the first (PDT) is taken.
        #expect(HealthDates.parse("2026-11-01T01:30", endOfDay: false, calendar: angeles) == HealthFixtures.date("2026-11-01T08:30:00Z"))
        // The 25-hour day, as local times.
        let start = try #require(HealthDates.parse("2026-11-01T00:00", endOfDay: false, calendar: angeles))
        let end = try #require(HealthDates.parse("2026-11-02T00:00", endOfDay: false, calendar: angeles))
        #expect(end.timeIntervalSince(start) == 25 * 3600)
    }

    @Test func aPhoneOnAnotherCalendarStillSpeaksGregorian() async throws {
        let zone = TimeZone(identifier: "Asia/Shanghai")!
        for identifier in [Calendar.Identifier.buddhist, .japanese, .republicOfChina, .islamicUmmAlQura, .hebrew] {
            let phone = HealthFixtures.calendar("Asia/Shanghai", identifier)
            // Parsed as Gregorian, whatever the phone's calendar says the year is.
            #expect(HealthDates.parse("2026-11-09", endOfDay: false, calendar: phone) == HealthFixtures.date("2026-11-08T16:00:00Z"), "\(identifier)")
            #expect(HealthDates.parse("2026-11-09", endOfDay: true, calendar: phone) == HealthFixtures.date("2026-11-09T16:00:00Z"), "\(identifier)")
            #expect(HealthDates.parse("2026-11-08T18:00:30.5", endOfDay: false, calendar: phone) == HealthFixtures.date("2026-11-08T10:00:30Z").addingTimeInterval(0.5), "\(identifier)")
            #expect(HealthDates.parse("2026-02-30", endOfDay: false, calendar: phone) == nil, "\(identifier)")
            #expect(phone.timeZone == zone)

            let health = FakeHealth()
            let actions = HealthFixtures.actions(health, calendar: identifier)
            let days = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-11-03","end":"2026-11-05","interval":"day"}"#)))
            #expect(days["startISO"]?.string == "2026-11-03T00:00:00+08:00", "\(identifier)")
            #expect(days["endISO"]?.string == "2026-11-06T00:00:00+08:00", "\(identifier)")
            #expect(days["results"]?.array?.first?["buckets"]?.array?.count == 3, "\(identifier)")
            let times = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"sleep","start":"2026-11-08T18:00","end":"2026-11-09T12:00"}"#)))
            #expect(times["startISO"]?.string == "2026-11-08T18:00:00+08:00", "\(identifier)")
            #expect(times["endISO"]?.string == "2026-11-09T12:00:00+08:00", "\(identifier)")
            let today = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#)))
            #expect(today["startISO"]?.string == "2026-11-09T00:00:00+08:00", "\(identifier)")
            #expect(today["timeZoneIdentifier"]?.string == "Asia/Shanghai")
            // Months are Gregorian months, not the phone calendar's.
            _ = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-10-15","end":"2026-11-20","interval":"month"}"#)))
            #expect(health.quantityRequests.last?.buckets.map(\.start) == [HealthFixtures.date("2026-09-30T16:00:00Z"), HealthFixtures.date("2026-10-31T16:00:00Z")], "\(identifier)")
            // Samples read the same window.
            _ = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","start":"2026-11-09"}"#)))
            #expect(health.sampleRequests.last?.window.start == HealthFixtures.date("2026-11-08T16:00:00Z"), "\(identifier)")
        }
    }

    @Test func withOnlyAnEndTheWindowIsThatDay() async throws {
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(FakeHealth()).run("health.stats", args: parseJSON(#"{"type":"stepCount","end":"2026-11-05"}"#)))
        #expect(reply["startISO"]?.string == "2026-11-05T00:00:00+08:00")
        #expect(reply["endISO"]?.string == "2026-11-06T00:00:00+08:00")
    }

    @Test func aDayInAZoneWithDaylightSavingIsAsLongAsItWas() async throws {
        let health = FakeHealth()
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health, zone: "America/Los_Angeles").run(
            "health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-11-01","end":"2026-11-01","interval":"day"}"#)
        ))
        // The clocks went back that night: 25 hours.
        let duration = try #require(health.quantityRequests.first?.window.duration)
        #expect(abs(duration - 25 * 3600) < 1)
        #expect(reply["results"]?.array?.first?["buckets"]?.array?.count == 1)
    }

    @Test func badWindowsAreInvalidArgs() async {
        let bad = [
            #"{"type":"stepCount","start":"2026-02-30"}"#,
            #"{"type":"stepCount","start":"yesterday"}"#,
            #"{"type":"stepCount","start":"2026-11-09T25:00"}"#,
            #"{"type":"stepCount","start":"2026-11-10"}"#,
            #"{"type":"stepCount","start":"2026-11-05","end":"2026-11-04"}"#,
            #"{"type":"stepCount","start":5}"#,
            #"{"type":"stepCount","end":""}"#,
        ]
        for args in bad {
            let health = FakeHealth()
            let result = await HealthFixtures.actions(health).run("health.stats", args: parseJSON(args))
            #expect(HealthFixtures.code(result) == "invalid_args", "\(args) -> \(result)")
            #expect(health.accessRequests == 0 && health.reads == 0, "a bad request must not ask Health: \(args)")
        }
    }

    @Test func typesAreRequiredAndValidated() async {
        let actions = HealthFixtures.actions(FakeHealth())
        #expect(HealthFixtures.code(await actions.run("health.stats", args: nil)) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON("{}"))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"types":[]}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"types":"stepCount"}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"types":[1]}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"types":["stepCount"],"type":"stepCount"}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"[]"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount","period":"today"}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON("{}"))) == "invalid_args")
    }

    @Test func aTypeOutsideTheAllowListIsUnsupported() async {
        let health = FakeHealth()
        let actions = HealthFixtures.actions(health)
        for args in [#"{"type":"bloodType"}"#, #"{"types":["stepCount","clinicalRecords"]}"#] {
            #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(args))) == "unsupported_type", "\(args)")
        }
        #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON(#"{"type":"electrocardiogram"}"#))) == "unsupported_type")
        #expect(health.accessRequests == 0)
    }

    @Test func unitsAndAggregatesMustFitTheType() async {
        let actions = HealthFixtures.actions(FakeHealth())
        let bad = [
            #"{"type":"stepCount","unit":"km"}"#,
            #"{"type":"distanceWalkingRunning","unit":"kg"}"#,
            #"{"type":"stepCount","aggregate":"avg"}"#,
            #"{"type":"stepCount","aggregate":"latest"}"#,
            #"{"type":"heartRate","aggregate":"sum"}"#,
            #"{"type":"heartRate","aggregate":"median"}"#,
            #"{"type":"heartRate","interval":"year"}"#,
        ]
        for args in bad {
            #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(args))) == "invalid_args", "\(args)")
        }
    }

    @Test func activityIsForWorkoutsOnly() async {
        let actions = HealthFixtures.actions(FakeHealth())
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount","activity":"running"}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"type":"workouts","activity":"quidditch"}"#))) == "invalid_args")
        #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","activity":"running"}"#))) == "invalid_args")
    }

    @Test func tooManyBucketsAreRefused() async {
        let health = FakeHealth()
        let result = await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-01-01","interval":"hour"}"#))
        #expect(HealthFixtures.code(result) == "invalid_args")
        #expect(health.reads == 0)
    }

    @Test func usageSaysSleepIsClippedToTheWindow() {
        let usage = HealthActions.usage()["health.stats"] ?? ""
        #expect(usage.contains("clipped to the window or bucket"))
        #expect(usage.contains("previous day 18:00 to 12:00"))
        #expect(usage.contains("with or without offset (without offset = the iPhone's time zone"))
        #expect(HealthActions.usage()["health.stats"]?.contains("health_off") == true)
        #expect(HealthActions.usage()["health.samples"]?.contains("health_off") == true)
        for action in ["health.stats", "health.samples"] {
            let text = HealthActions.usage()[action] ?? ""
            #expect(text.contains("Settings → Apple Health → Sync with Rome in the Rome app"), "\(action)")
            #expect(text.contains("on the iPhone"), "\(action)")
        }
        #expect(HealthActions.usage()["health.stats"]?.contains("off for Rome until the user turns it on") == true, "off is the default")
    }

    @Test func unknownActionIsUnsupported() async {
        #expect(HealthFixtures.code(await HealthFixtures.actions(FakeHealth()).run("health.write", args: nil)) == "unsupported_action")
    }
}

@Suite struct HealthAccessTests {
    @Test func theFirstRequestAsksForAccessBeforeReading() async throws {
        let health = FakeHealth()
        _ = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#)))
        #expect(health.accessRequests == 1)
        #expect(health.reads == 1)
    }

    @Test func noHealthKitIsHealthUnavailable() async {
        let health = FakeHealth()
        health.available = false
        #expect(HealthFixtures.code(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#))) == "health_unavailable")
        #expect(HealthFixtures.code(await HealthFixtures.actions(health).run("health.samples", args: parseJSON(#"{"type":"stepCount"}"#))) == "health_unavailable")
        #expect(health.reads == 0)
    }

    @Test func withTheSwitchOffTheHealthActionsAreRefusedBeforeHealthIsTouched() async {
        let health = FakeHealth()
        let actions = HealthFixtures.actions(health)
        actions.enabled.set(false)
        for (action, args) in [("health.stats", #"{"type":"stepCount"}"#), ("health.samples", #"{"type":"heartRate"}"#), ("health.stats", "{}"), ("health.stats", #"{"type":"bloodType"}"#)] {
            let result = await actions.run(action, args: parseJSON(args))
            #expect(HealthFixtures.code(result) == "health_off", "\(action) \(args)")
        }
        guard case .failed(code: _, message: let message) = await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#)) else { return }
        #expect(message.contains("Settings → Apple Health → Sync with Rome in the Rome app"), "the agent is told where the user turns it on")
        #expect(message.contains("on the iPhone"))
        #expect(health.accessRequests == 0 && health.reads == 0)
        // Other actions are not Health's to refuse.
        #expect(HealthFixtures.code(await actions.run("health.write", args: nil)) == "unsupported_action")
        // Back on, the same request runs.
        actions.enabled.set(true)
        #expect(HealthFixtures.code(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#))) == nil)
    }

    @Test func aLockedPhoneIsHealthLocked() async {
        let health = FakeHealth()
        health.accessError = .locked
        #expect(HealthFixtures.code(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#))) == "health_locked")
        #expect(health.reads == 0)
    }
}

@Suite struct HealthStatsTests {
    @Test func totalsAnswerPerTypeAndOmitWhatHasNoValue() async throws {
        let health = FakeHealth()
        health.quantities["stepCount"] = [8432]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"types":["stepCount","restingHeartRate","stepCount"]}"#)
        ))
        #expect(reply["interval"]?.string == "total")
        let results = try #require(reply["results"]?.array)
        #expect(results.count == 2, "a repeated type counts once")
        #expect(results[0] == parseJSON(#"{"type":"stepCount","unit":"count","aggregate":"sum","value":8432}"#))
        // No data and no access look the same: no value, never 0.
        #expect(results[1] == parseJSON(#"{"type":"restingHeartRate","unit":"count/min","aggregate":"avg"}"#))
    }

    @Test func aggregateAndUnitReachTheReader() async throws {
        let health = FakeHealth()
        health.quantities["distanceWalkingRunning"] = [5.2]
        health.quantities["heartRate"] = [140]
        _ = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"types":["distanceWalkingRunning"],"unit":"km"}"#)
        ))
        _ = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"types":["heartRate"],"aggregate":"max"}"#)
        ))
        #expect(health.quantityRequests[0].unit.name == "km")
        #expect(health.quantityRequests[0].aggregate == .sum)
        #expect(health.quantityRequests[1].aggregate == .max)
        #expect(health.quantityRequests[1].unit.name == "count/min")
    }

    @Test func oxygenSaturationIsInPercent() async throws {
        let health = FakeHealth()
        _ = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"oxygenSaturation"}"#)))
        #expect(health.quantityRequests.first?.unit == HealthUnit(name: "%", hk: "%", scale: 100))
    }

    @Test func dayBucketsCarryTheirOwnValues() async throws {
        let health = FakeHealth()
        health.quantities["stepCount"] = [1000, 2000, 3000, nil, 5000, 6000, 7000]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-11-03","end":"2026-11-09","interval":"day"}"#)
        ))
        let result = try #require(reply["results"]?.array?.first)
        #expect(result["value"] == nil, "buckets replace the total")
        let buckets = try #require(result["buckets"]?.array)
        #expect(buckets.count == 7)
        #expect(buckets[0] == parseJSON(#"{"startISO":"2026-11-03T00:00:00+08:00","endISO":"2026-11-04T00:00:00+08:00","value":1000}"#))
        #expect(buckets[3] == parseJSON(#"{"startISO":"2026-11-06T00:00:00+08:00","endISO":"2026-11-07T00:00:00+08:00"}"#))
        #expect(health.quantityRequests.first?.buckets.count == 7)
        #expect(health.quantityRequests.first?.interval == .day)
    }

    @Test func aWeekIsAskedForWholeButReportedClipped() async throws {
        let health = FakeHealth()
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"type":"stepCount","start":"2026-11-04","end":"2026-11-10","interval":"week"}"#)
        ))
        // 4 November 2026 is a Wednesday; weeks start on Monday.
        let request = try #require(health.quantityRequests.first)
        #expect(request.buckets.map(\.start) == [HealthFixtures.date("2026-11-01T16:00:00Z"), HealthFixtures.date("2026-11-08T16:00:00Z")])
        let buckets = try #require(reply["results"]?.array?.first?["buckets"]?.array)
        #expect(buckets.map { $0["startISO"]?.string } == ["2026-11-04T00:00:00+08:00", "2026-11-09T00:00:00+08:00"])
        #expect(buckets.map { $0["endISO"]?.string } == ["2026-11-09T00:00:00+08:00", "2026-11-11T00:00:00+08:00"])
    }

    @Test func bucketsStopAtAThousand() {
        let calendar = HealthFixtures.calendar("UTC")
        let start = HealthFixtures.date("2026-01-01T00:00:00Z")
        #expect(HealthBucket.make(window: DateInterval(start: start, duration: 1000 * 3600), interval: .hour, calendar: calendar)?.count == 1000)
        #expect(HealthBucket.make(window: DateInterval(start: start, duration: 1001 * 3600), interval: .hour, calendar: calendar) == nil)
        #expect(HealthBucket.make(window: DateInterval(start: start, duration: 3 * 86_400), interval: .total, calendar: calendar)?.count == 1)
    }

    @Test func sleepMergesStagesAndSourcesWithoutCountingAMinuteTwice() async throws {
        let health = FakeHealth()
        func segment(_ stage: SleepStage, _ start: String, _ end: String) -> HealthSegment {
            HealthSegment(start: HealthFixtures.date(start), end: HealthFixtures.date(end), stage: stage)
        }
        health.segmentsByType["sleep"] = [
            segment(.inBed, "2026-11-08T22:00:00+08:00", "2026-11-09T07:00:00+08:00"),
            segment(.core, "2026-11-08T23:00:00+08:00", "2026-11-09T01:00:00+08:00"),
            segment(.deep, "2026-11-09T01:00:00+08:00", "2026-11-09T02:00:00+08:00"),
            segment(.rem, "2026-11-09T02:00:00+08:00", "2026-11-09T03:00:00+08:00"),
            segment(.core, "2026-11-09T03:00:00+08:00", "2026-11-09T05:30:00+08:00"),
            segment(.rem, "2026-11-09T05:30:00+08:00", "2026-11-09T06:30:00+08:00"),
            segment(.awake, "2026-11-09T06:30:00+08:00", "2026-11-09T06:40:00+08:00"),
            // A second app records the same night: unspecified sleep over the stages, and a brief awake over core.
            segment(.unspecified, "2026-11-08T23:30:00+08:00", "2026-11-09T05:00:00+08:00"),
            segment(.awake, "2026-11-09T00:00:00+08:00", "2026-11-09T00:10:00+08:00"),
        ]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"type":"sleep","start":"2026-11-08T12:00:00+08:00","end":"2026-11-09T12:00:00+08:00"}"#)
        ))
        let result = try #require(reply["results"]?.array?.first)
        #expect(result == parseJSON(#"""
        {"type":"sleep","unit":"min","aggregate":"sum","value":450,
         "stages":{"core":270,"deep":60,"rem":120,"awake":10,"inBed":540}}
        """#))
    }

    @Test func sleepIsClippedToTheWindow() async throws {
        let health = FakeHealth()
        health.segmentsByType["sleep"] = [
            HealthSegment(start: HealthFixtures.date("2026-11-08T23:00:00+08:00"), end: HealthFixtures.date("2026-11-09T07:00:00+08:00"), stage: .core),
            HealthSegment(start: HealthFixtures.date("2026-11-08T22:00:00+08:00"), end: HealthFixtures.date("2026-11-09T07:00:00+08:00"), stage: .inBed),
        ]
        // The default window, today from midnight.
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"sleep"}"#)))
        let result = try #require(reply["results"]?.array?.first)
        #expect(result["value"]?.number == 420)
        #expect(result["stages"]?["inBed"]?.number == 420)
    }

    @Test func sleepAcrossMidnightSplitsBetweenDayBuckets() async throws {
        let health = FakeHealth()
        health.segmentsByType["sleep"] = [
            HealthSegment(start: HealthFixtures.date("2026-11-08T23:00:00+08:00"), end: HealthFixtures.date("2026-11-09T01:00:00+08:00"), stage: .core),
        ]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"type":"sleep","start":"2026-11-08","end":"2026-11-09","interval":"day"}"#)
        ))
        let buckets = try #require(reply["results"]?.array?.first?["buckets"]?.array)
        #expect(buckets.map { $0["value"]?.number } == [60, 60])
    }

    @Test func noSleepRecordsMeansNoValue() async throws {
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(FakeHealth()).run("health.stats", args: parseJSON(#"{"type":"sleep"}"#)))
        #expect(reply["results"]?.array?.first == parseJSON(#"{"type":"sleep","unit":"min","aggregate":"sum"}"#))
    }

    @Test func mindfulMinutesMergeToo() async throws {
        let health = FakeHealth()
        health.segmentsByType["mindfulSession"] = [
            HealthSegment(start: HealthFixtures.date("2026-11-09T08:00:00+08:00"), end: HealthFixtures.date("2026-11-09T08:10:00+08:00")),
            HealthSegment(start: HealthFixtures.date("2026-11-09T08:05:00+08:00"), end: HealthFixtures.date("2026-11-09T08:20:00+08:00")),
        ]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.stats", args: parseJSON(#"{"type":"mindfulSession"}"#)))
        #expect(reply["results"]?.array?.first?["value"]?.number == 20)
    }

    @Test func workoutsAreCountedByTheirStart() async throws {
        let health = FakeHealth()
        func run(_ start: String, minutes: Double, energy: Double?, distance: Double?) -> WorkoutRecord {
            let from = HealthFixtures.date(start)
            return WorkoutRecord(start: from, end: from.addingTimeInterval(minutes * 60), activity: "running", durationMinutes: minutes, activeEnergyKcal: energy, distanceMeters: distance)
        }
        health.workoutRecords = [
            run("2026-11-07T07:30:00+08:00", minutes: 40, energy: 320, distance: 5200),
            run("2026-11-09T07:00:00+08:00", minutes: 30, energy: 250, distance: nil),
            // Began the day before the window: it belongs to that day.
            run("2026-11-02T23:50:00+08:00", minutes: 30, energy: 200, distance: 3000),
        ]
        let actions = HealthFixtures.actions(health)
        let total = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"workouts","start":"2026-11-03","end":"2026-11-09","activity":"running"}"#)))
        #expect(health.workoutActivities.last == "running")
        #expect(total["results"]?.array?.first == parseJSON(#"""
        {"type":"workouts","unit":"count","value":2,"count":2,"durationMinutes":70,"activeEnergyKcal":570,"distanceMeters":5200}
        """#))
        let days = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"workouts","start":"2026-11-02","end":"2026-11-09","interval":"day"}"#)))
        let buckets = try #require(days["results"]?.array?.first?["buckets"]?.array)
        #expect(buckets.map { $0["count"]?.number } == [1, 0, 0, 0, 0, 1, 0, 1])
        #expect(buckets[1]["durationMinutes"] == nil, "a day without workouts has a count and nothing else")
    }

    @Test func theWholeOpenClawCommandIsOneCall() async throws {
        let health = FakeHealth()
        health.quantities["stepCount"] = [9000]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run(
            "health.stats", args: parseJSON(#"{"types":["stepCount","sleep","restingHeartRate","workouts"]}"#)
        ))
        #expect(reply["results"]?.array?.compactMap { $0["type"]?.string } == ["stepCount", "sleep", "restingHeartRate", "workouts"])
        #expect(health.accessRequests == 1)
    }
}

@Suite struct HealthSamplesTests {
    private func ids(_ reply: JSONValue) -> [String] {
        reply["samples"]?.array?.compactMap { $0["id"]?.string } ?? []
    }

    private func store() -> FakeHealth {
        let health = FakeHealth()
        health.sampleStore = [
            HealthFixtures.sample("a", "2026-11-09T10:00:00Z", value: 61),
            HealthFixtures.sample("b", "2026-11-09T10:01:00Z", value: 62),
            HealthFixtures.sample("c", "2026-11-09T10:01:00Z", value: 63, source: "Phone"),
            HealthFixtures.sample("d", "2026-11-09T10:01:00Z", value: 64),
            HealthFixtures.sample("e", "2026-11-09T10:05:00Z", value: 65),
        ]
        return health
    }

    @Test func defaultsAreTheNewestHundredOfToday() async throws {
        let health = store()
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.samples", args: parseJSON(#"{"type":"heartRate"}"#)))
        #expect(health.sampleRequests.first?.limit == 101, "one more than asked, to know whether there is a next page")
        #expect(health.sampleRequests.first?.ascending == false)
        #expect(ids(reply) == ["e", "d", "c", "b", "a"])
        #expect(reply["nextCursor"] == nil)
        #expect(reply["type"]?.string == "heartRate")
        #expect(reply["unit"]?.string == "count/min")
        #expect(reply["timeZoneIdentifier"]?.string == "Asia/Shanghai")
        #expect(reply["samples"]?.array?.first == parseJSON(#"""
        {"id":"e","startISO":"2026-11-09T18:05:00+08:00","endISO":"2026-11-09T18:06:00+08:00","value":65,
         "source":{"name":"Watch","bundleId":"com.example.watch"}}
        """#))
    }

    @Test func pagesNeitherRepeatNorSkipRecordsThatShareAStart() async throws {
        for order in ["desc", "asc"] {
            let health = store()
            let actions = HealthFixtures.actions(health)
            var seen: [String] = []
            var cursor: String?
            var pages = 0
            repeat {
                var args = #"{"type":"heartRate","limit":2,"order":"\#(order)","start":"2026-11-09T00:00:00Z","end":"2026-11-09T23:00:00Z""#
                if let cursor { args += #","cursor":"\#(cursor)""# }
                let reply = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(args + "}")))
                seen += ids(reply)
                cursor = reply["nextCursor"]?.string
                pages += 1
            } while cursor != nil && pages < 10
            #expect(pages == 3, "\(order)")
            #expect(Set(seen).count == 5 && seen.count == 5, "\(order): \(seen)")
            let times = seen.map { id in health.sampleStore.first { $0.id == id }!.start }
            #expect(times == times.sorted { order == "asc" ? $0 < $1 : $0 > $1 }, "\(order) order")
        }
    }

    /// Pages through a query while the clock moves, as it does between a caller's requests.
    private func page(_ args: String, clock: TestClock, health: FakeHealth, between: () -> Void) async throws -> (ids: [String], windows: [String?]) {
        let calendar = HealthFixtures.calendar("Asia/Shanghai")
        let actions = HealthActions(reader: health, now: { clock.now }, calendar: { calendar })
        var seen: [String] = []
        var windows: [String?] = []
        var cursor: String?
        var pages = 0
        repeat {
            var text = args
            if let cursor { text = String(args.dropLast()) + #","cursor":"\#(cursor)"}"# }
            let reply = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(text)))
            seen += ids(reply)
            windows.append((reply["startISO"]?.string).flatMap { start in reply["endISO"]?.string.map { "\(start)..\($0)" } })
            cursor = reply["nextCursor"]?.string
            pages += 1
            between()
        } while cursor != nil && pages < 10
        return (seen, windows)
    }

    @Test func pagesKeepWorkingWhenEndIsOmittedAndTimeMovesOn() async throws {
        let health = store()
        let clock = TestClock(HealthFixtures.now)
        let result = try await page(#"{"type":"heartRate","start":"2026-11-09T00:00:00Z","limit":2}"#, clock: clock, health: health) {
            clock.advance(300)
            // A sample arrives after the first page: later pages do not show it.
            health.sampleStore.append(HealthFixtures.sample("late", RomeDate.string(clock.now), value: 70))
        }
        #expect(result.ids == ["e", "d", "c", "b", "a"])
        #expect(Set(result.windows).count == 1, "every page reports the first page's window: \(result.windows)")
    }

    @Test func pagesKeepWorkingWhenStartAndEndAreOmittedAcrossMidnight() async throws {
        let health = store()
        let clock = TestClock(HealthFixtures.now)
        // 18:30 in Shanghai on 9 November; the next page is after midnight, when "today" is another day.
        let result = try await page(#"{"type":"heartRate","limit":2}"#, clock: clock, health: health) {
            clock.advance(7 * 3600)
        }
        #expect(result.ids == ["e", "d", "c", "b", "a"])
        #expect(Set(result.windows).count == 1, "\(result.windows)")
        #expect(result.windows.first??.hasPrefix("2026-11-09T00:00:00+08:00") == true)
    }

    @Test func aCursorStillBelongsToItsArgumentsWhenEndIsOmitted() async throws {
        let actions = HealthFixtures.actions(store())
        let first = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":1}"#)))
        let cursor = try #require(first["nextCursor"]?.string)
        // The same window written out is another query: the cursor was made for the arguments as given.
        let explicit = await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":1,"start":"2026-11-09","cursor":"\#(cursor)"}"#))
        #expect(HealthFixtures.code(explicit) == "invalid_args")
        let other = await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":1,"end":"2026-11-09","cursor":"\#(cursor)"}"#))
        #expect(HealthFixtures.code(other) == "invalid_args")
        // limit and includeMetadata may change between pages.
        let changed = await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":3,"includeMetadata":true,"cursor":"\#(cursor)"}"#))
        #expect((try? HealthFixtures.ok(changed)) != nil)
    }

    private func forged(_ json: String) -> String { CloudAuth.base64URL(Data(json.utf8)) }

    @Test func aForgedCursorIsRefusedAndNeverCrashes() async throws {
        let forgeries = [
            #"{"q":"","t":1e100,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":-1e100,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":0,"ws":0,"we":1e100}"#,
            #"{"q":"","t":0,"s":0,"ws":-1e100,"we":1}"#,
            #"{"q":"","t":1.5,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":0,"ws":0.5,"we":1}"#,
            #"{"q":"","t":0,"s":0.5,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":-1,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":1e100,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":100000,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":0,"ws":5,"we":5}"#,
            #"{"q":"","t":0,"s":0,"ws":9,"we":5}"#,
            #"{"q":"","t":9223372036854775807,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":0,"s":0,"ws":0,"we":9223372036854775807}"#,
            #"{"q":"","t":-1e30,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":300000000000000,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":"5","s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":null,"s":0,"ws":0,"we":1}"#,
            #"{"q":"","t":5}"#,
            #"{"q":7,"t":5,"s":0,"ws":0,"we":1}"#,
            #"[]"#, #"7"#, #"null"#,
        ]
        for json in forgeries { #expect(SampleCursor(forged(json)) == nil, "\(json)") }
        let health = store()
        let actions = HealthFixtures.actions(health)
        for json in forgeries {
            let result = await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","cursor":"\#(forged(json))"}"#))
            #expect(HealthFixtures.code(result) == "invalid_args", "\(json)")
        }
        #expect(health.reads == 0 && health.accessRequests == 0, "a forged cursor touches nothing")
    }

    @Test func aCursorRoundTripsAndAGoodNumberIsKept() throws {
        let window = DateInterval(start: HealthFixtures.date("2026-11-03T00:00:00Z"), end: HealthFixtures.date("2026-11-09T10:30:00.123Z"))
        let cursor = SampleCursor(query: "heartRate|2026-11-03||desc||", window: window, startMs: 1_794_240_000_000, skip: 7)
        let decoded = try #require(SampleCursor(cursor.encoded))
        #expect(decoded == cursor)
        #expect(decoded.window == window)
        // The extremes of a date the wire can name are still fine.
        #expect(SampleCursor(forged(#"{"q":"","t":-62135596800000,"s":0,"ws":-62135596800000,"we":253402300799999}"#)) != nil)
    }

    @Test func aPageThatFillsExactlyHasNoNextCursor() async throws {
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(store()).run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":5}"#)))
        #expect(ids(reply).count == 5)
        #expect(reply["nextCursor"] == nil)
    }

    @Test func aCursorBelongsToItsQuery() async throws {
        let actions = HealthFixtures.actions(store())
        let first = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":1}"#)))
        let cursor = try #require(first["nextCursor"]?.string)
        for args in [
            #"{"type":"heartRate","limit":1,"order":"asc","cursor":"\#(cursor)"}"#,
            #"{"type":"restingHeartRate","limit":1,"cursor":"\#(cursor)"}"#,
            #"{"type":"heartRate","limit":1,"start":"2026-11-08","cursor":"\#(cursor)"}"#,
            #"{"type":"heartRate","limit":1,"cursor":"not-a-cursor"}"#,
        ] {
            #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON(args))) == "invalid_args", "\(args)")
        }
        let same = await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":1,"cursor":"\#(cursor)"}"#))
        #expect((try? HealthFixtures.ok(same)) != nil)
    }

    @Test func limitIsAWholeNumberFromOneToAThousand() async {
        let actions = HealthFixtures.actions(store())
        for limit in ["0", "1001", "-1", "1.5", #""10""#] {
            #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":\#(limit)}"#))) == "invalid_args", "\(limit)")
        }
        for limit in ["1", "1000"] {
            #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","limit":\#(limit)}"#))) == nil, "\(limit)")
        }
    }

    @Test func otherArgsAreValidated() async {
        let actions = HealthFixtures.actions(store())
        for args in [
            #"{"type":"heartRate","order":"newest"}"#,
            #"{"type":"heartRate","sources":"Watch"}"#,
            #"{"type":"heartRate","sources":[1]}"#,
            #"{"type":"heartRate","includeMetadata":"yes"}"#,
            #"{"type":["heartRate"]}"#,
        ] {
            #expect(HealthFixtures.code(await actions.run("health.samples", args: parseJSON(args))) == "invalid_args", "\(args)")
        }
    }

    @Test func sourcesKeepByNameOrBundleId() async throws {
        let actions = HealthFixtures.actions(store())
        let byName = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","sources":["Phone"]}"#)))
        #expect(ids(byName) == ["c"])
        let byBundle = try HealthFixtures.ok(await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate","sources":["com.example.watch"]}"#)))
        #expect(ids(byBundle) == ["e", "d", "b", "a"])
    }

    @Test func metadataAndDeviceTravelOnlyWhenAskedFor() async throws {
        let health = FakeHealth()
        var sample = HealthFixtures.sample("m", "2026-11-09T10:00:00Z", category: "core")
        sample.device = ["name": "Apple Watch", "model": "Watch7,1"]
        sample.metadata = ["HKWasUserEntered": .bool(false)]
        health.sampleStore = [sample]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.samples", args: parseJSON(#"{"type":"sleep","includeMetadata":true}"#)))
        #expect(health.sampleRequests.last?.includeMetadata == true)
        let first = try #require(reply["samples"]?.array?.first)
        #expect(first["category"]?.string == "core")
        #expect(first["metadata"] == parseJSON(#"{"HKWasUserEntered":false}"#))
        #expect(first["device"] == parseJSON(#"{"name":"Apple Watch","model":"Watch7,1"}"#))
        #expect(reply["unit"] == nil, "a category has no unit")
        _ = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.samples", args: parseJSON(#"{"type":"sleep"}"#)))
        #expect(health.sampleRequests.last?.includeMetadata == false)
    }

    @Test func workoutSamplesCarryTheirWorkout() async throws {
        let health = FakeHealth()
        var sample = HealthFixtures.sample("w", "2026-11-09T09:00:00Z")
        sample.workout = WorkoutRecord(start: sample.start, end: sample.end, activity: "running", durationMinutes: 40, activeEnergyKcal: 320, distanceMeters: nil)
        health.sampleStore = [sample]
        let reply = try HealthFixtures.ok(await HealthFixtures.actions(health).run("health.samples", args: parseJSON(#"{"type":"workouts","activity":"running"}"#)))
        #expect(reply["samples"]?.array?.first?["workout"] == parseJSON(#"{"activity":"running","durationMinutes":40,"activeEnergyKcal":320}"#))
        #expect(health.sampleRequests.last?.activity == "running")
    }
}

/// Sleep, mindful minutes and workouts are read record by record, so one
/// request reads a bounded window of them.
@Suite struct HealthRecordWindowTests {
    @Test(arguments: ["sleep", "mindfulSession", "workouts"])
    func aWindowOverAYearOfRecordsIsRefusedBeforeHealthIsRead(type: String) async {
        let health = FakeHealth()
        let actions = HealthFixtures.actions(health)
        let result = await actions.run("health.stats", args: parseJSON(#"{"types":["stepCount","\#(type)"],"start":"2024-11-01","end":"2025-11-02"}"#))
        #expect(HealthFixtures.code(result) == "invalid_args")
        #expect(health.reads == 0)
        #expect(health.accessRequests == 0)
    }

    @Test func aYearOfSleepIsRead() async throws {
        let health = FakeHealth()
        let actions = HealthFixtures.actions(health)
        // 366 days, a leap year's worth, is the most.
        _ = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"sleep","start":"2024-01-01","end":"2024-12-31"}"#)))
        #expect(health.reads == 1)
    }

    @Test func stepsOverYearsAreStillSummedByHealthKit() async throws {
        let health = FakeHealth()
        let actions = HealthFixtures.actions(health)
        _ = try HealthFixtures.ok(await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount","start":"2020-01-01","end":"2025-12-31","interval":"month"}"#)))
        #expect(health.reads == 1)
    }

    @Test func theUsageTellsTheAgentTheLimit() throws {
        let usage = try #require(HealthActions.usage()["health.stats"])
        #expect(usage.contains("at most 366 days"))
    }
}

/// An iPad works as an iPhone does; only the device word changes.
@Suite struct DeviceWordTests {
    private func actions(_ device: DeviceKind) -> HealthActions {
        var actions = HealthFixtures.actions(FakeHealth())
        actions.device = device
        return actions
    }

    @Test func anIPadTellsTheAgentWhereItsSwitchIs() async {
        var actions = actions(.iPad)
        actions.enabled = NodeFlag(false)
        guard case .failed(code: "health_off", message: let message) = await actions.run("health.stats", args: parseJSON(#"{"type":"stepCount"}"#)) else {
            Issue.record("expected health_off")
            return
        }
        #expect(message.contains("Settings → Apple Health → Sync with Rome in the Rome app"))
        #expect(!message.contains("iPhone"))
        for text in HealthActions.usage(.iPad).values {
            #expect(!text.contains("iPhone") && !text.contains("phone's"), "\(text.prefix(40))")
        }
        #expect(HealthActions.usage(.iPad)["health.stats"]?.contains("Settings → Apple Health → Sync with Rome in the Rome app") == true)
    }

    @Test func anIPhoneStillSaysIPhone() async {
        var actions = actions(.iPhone)
        actions.enabled = NodeFlag(false)
        guard case .failed(code: _, message: let message) = await actions.run("health.samples", args: parseJSON(#"{"type":"heartRate"}"#)) else {
            Issue.record("expected health_off")
            return
        }
        #expect(message.contains("Settings → Apple Health → Sync with Rome in the Rome app"))
    }

    @Test func theAuditRefusalNamesTheDevice() async throws {
        let audit = FakeAudit()
        audit.refuse = true
        let executor = NodeExecutor(name: { "iPad" }, audit: audit, registry: .testing(actions(.iPad)), device: .iPad)
        let reply = parseJSON(try #require(await executor.respond(
            to: #"{"id":"r1","from":"inst-1","payload":{"type":"request","action":"health.stats","args":{"type":"stepCount"}}}"#,
            session: NodeSession()
        )))
        let message = try #require(reply["payload"]?["error"]?["message"]?.string)
        #expect(message.hasPrefix("This iPad could not record"))
        #expect(!message.contains("iPhone"))
    }

    @Test func settingsCopyFollowsTheDevice() {
        #expect(DeviceKind.iPad.name == "iPad")
        #expect(DeviceKind.iPad.symbol == "ipad")
        #expect(DeviceKind.iPhone.symbol == "iphone")
        #expect(DeviceKind.iPad.useSwitchTitle == LocalizedStringKey("Can Rome use this iPad"))
        #expect(DeviceKind.iPhone.groupTitle == LocalizedStringKey("iPhone use"))
    }
}
