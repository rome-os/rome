import Foundation
import Testing
@testable import Rome

@Suite struct NodeActivityTests {
    /// 9 November 2026, 18:30 in Shanghai.
    private let now = HealthFixtures.now
    private let calendar = HealthFixtures.calendar("Asia/Shanghai")

    private var formatter: NodeActivityFormatter {
        NodeActivityFormatter(registry: .testing(HealthFixtures.actions(FakeHealth())), now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
    }

    private func entry(
        _ seq: Int = 1, at time: String = "2026-11-09T01:21:00Z", action: String = "health.stats", args: String,
        outcome: NodeOutcome? = .ok, error: String? = nil, count: Int? = nil, window: (String, String)? = nil
    ) -> NodeAuditEntry {
        NodeAuditEntry(
            seq: seq, time: HealthFixtures.date(time), from: "inst", action: action, args: args, outcome: outcome, errorCode: error, count: count,
            windowStart: window.map { HealthFixtures.date($0.0) }, windowEnd: window.map { HealthFixtures.date($0.1) }, durationMs: 5
        )
    }

    /// iOS puts a narrow no-break space before AM/PM.
    private func row(_ entry: NodeAuditEntry) -> (title: String, detail: String, time: String, failed: Bool) {
        let row = formatter.row(entry)
        func plain(_ text: String) -> String { text.replacingOccurrences(of: "\u{202F}", with: " ") }
        return (plain(row.title), plain(row.detail), plain(row.time), row.failed)
    }

    @Test func aSummaryOfTodayNamesTheTypesAndCounts() {
        let result = row(entry(args: #"{"types":["stepCount","sleep","restingHeartRate","workouts"]}"#, count: 4,
                               window: ("2026-11-08T16:00:00Z", "2026-11-09T01:21:00Z")))
        #expect(result.title == "Steps, Sleep, Resting heart rate +1")
        #expect(result.detail == "Today")
        #expect(result.time == "9:21 AM")
        #expect(!result.failed)
    }

    @Test func threeTypesAreNamedInFullAndMoreAreCounted() {
        #expect(row(entry(args: #"{"types":["stepCount","sleep","heartRate"]}"#)).title == "Steps, Sleep, Heart rate")
        #expect(row(entry(args: #"{"types":["stepCount","sleep","heartRate","bodyMass","height"]}"#)).title == "Steps, Sleep, Heart rate +2")
        #expect(row(entry(args: #"{"type":"workouts"}"#)).title == "Workouts")
    }

    @Test func aWeekByDay() {
        let result = row(entry(args: #"{"type":"stepCount","start":"2026-11-03","end":"2026-11-09","interval":"day"}"#, count: 1,
                               window: ("2026-11-02T16:00:00Z", "2026-11-09T16:00:00Z")))
        #expect(result.detail == "Nov 3 – Today · by day")
    }

    @Test func statsRowsShowNoCountButRecordsDo() {
        #expect(!row(entry(args: #"{"types":["stepCount","sleep"]}"#, count: 2)).detail.contains("result"))
        #expect(!row(entry(args: #"{"type":"stepCount"}"#, count: 1)).detail.contains("1"))
        #expect(row(entry(action: "health.samples", args: #"{"type":"heartRate"}"#, count: 3)).detail.hasSuffix("3 records"))
    }

    @Test func everyModeHasItsWords() {
        for (interval, words) in [("hour", "by hour"), ("day", "by day"), ("week", "by week"), ("month", "by month")] {
            #expect(row(entry(args: #"{"type":"stepCount","interval":"\#(interval)"}"#, count: 2)).detail.contains(words), "\(interval)")
        }
        #expect(!row(entry(args: #"{"type":"stepCount","interval":"total"}"#, count: 2)).detail.contains("by"))
    }

    @Test func recordsNameTheTypeAndCountRecords() {
        let first = row(entry(action: "health.samples", args: #"{"type":"heartRate","limit":3}"#, count: 3,
                              window: ("2026-11-08T16:00:00Z", "2026-11-09T01:21:00Z")))
        #expect(first.title == "Heart rate records")
        #expect(first.detail == "Today · 3 records")
        #expect(row(entry(action: "health.samples", args: #"{"type":"heartRate"}"#, count: 1)).detail.hasSuffix("1 record"))
    }

    @Test func aContinuedPageSaysNextPageNotTheCursor() {
        let result = row(entry(action: "health.samples", args: #"{"cursor":"eyJxIjoiaGVhcnRSYXRlfDIwMjYtMTEtMDN8fGRlc2N8fCIs","limit":3,"start":"2026-11-03","type":"heartRate"}"#, count: 3,
                               window: ("2026-11-02T16:00:00Z", "2026-11-09T01:21:00Z")))
        #expect(result.title == "Heart rate records")
        #expect(result.detail == "Nov 3 – Today · 3 records · next page")
        #expect(!result.detail.contains("eyJ") && !result.title.contains("eyJ"))
    }

    @Test func aWindowOfTimesShowsDatesAndTimes() {
        let result = row(entry(args: #"{"type":"sleep","start":"2026-11-08T18:00","end":"2026-11-09T12:00"}"#, count: 1,
                               window: ("2026-11-08T10:00:00Z", "2026-11-09T04:00:00Z")))
        #expect(result.detail == "Nov 8, 6 PM – Nov 9, 12 PM")
    }

    @Test func aTimeOffTheHourKeepsItsMinutes() {
        let result = row(entry(args: #"{"type":"sleep","start":"2026-11-08T18:30","end":"2026-11-09T12:00"}"#, count: 1))
        #expect(result.detail == "Nov 8, 6:30 PM – Nov 9, 12 PM")
    }

    @Test func oneDayAndYesterdayAndAnOlderDay() {
        #expect(row(entry(args: #"{"type":"stepCount","start":"2026-11-08","end":"2026-11-08"}"#, count: 1, window: ("2026-11-07T16:00:00Z", "2026-11-08T16:00:00Z"))).detail == "Yesterday")
        #expect(row(entry(args: #"{"type":"stepCount","start":"2026-11-07","end":"2026-11-07"}"#, count: 1, window: ("2026-11-06T16:00:00Z", "2026-11-07T16:00:00Z"))).detail == "Nov 7")
        #expect(row(entry(args: #"{"type":"stepCount","start":"2025-12-31","end":"2025-12-31"}"#, count: 1, window: ("2025-12-30T16:00:00Z", "2025-12-31T16:00:00Z"))).detail == "Dec 31, 2025")
    }

    @Test func withoutARecordedWindowItIsWorkedOutFromTheArgs() {
        #expect(row(entry(args: "{}", count: 1)).detail == "Today")
        #expect(row(entry(args: #"{"type":"stepCount","start":"2026-11-03","end":"2026-11-09"}"#, count: 1)).detail == "Nov 3 – Today")
        #expect(row(entry(args: #"{"type":"sleep","start":"2026-11-08T18:00","end":"2026-11-09T12:00"}"#, count: 1)).detail == "Nov 8, 6 PM – Nov 9, 12 PM")
    }

    @Test func failuresSayWhyInShortWords() {
        let cases = [
            ("unsupported_type", "Not a supported type"), ("invalid_args", "Invalid request"), ("health_off", "Apple Health is off"),
            ("health_locked", "Health unavailable while locked"), ("health_unavailable", "Health isn't available"),
            ("audit_unavailable", "Couldn't record activity"), ("health_failed", "Couldn't read Health"), ("who_knows", "Something went wrong"),
        ]
        for (code, words) in cases {
            let result = row(entry(args: #"{"type":"bloodType"}"#, outcome: .error, error: code))
            #expect(result.detail == words, "\(code)")
            #expect(result.failed, "\(code)")
        }
        #expect(row(entry(args: #"{"type":"bloodType"}"#, outcome: .error, error: "unsupported_type")).title == "bloodType", "an unknown name is shown as sent")
    }

    @Test func anUnknownActionIsAnUnsupportedRequest() {
        let result = row(entry(action: "exec", args: #"{"command":"ls"}"#, outcome: .error, error: "unsupported_action"))
        #expect(result.title == "Unsupported request")
        #expect(result.detail == "exec", "the action's name, not a reason")
        #expect(!result.failed, "in the plain color")
        #expect(!result.detail.contains("ls"), "never the args")
    }

    @Test func aRequestWithoutAnEndIsInterrupted() {
        let result = row(entry(args: #"{"type":"stepCount"}"#, outcome: nil))
        #expect(result.detail.hasSuffix("Interrupted"))
        #expect(!result.failed)
    }

    @Test func rowsShowNoJSONActionsOrDurations() {
        let result = row(entry(action: "health.samples", args: #"{"limit":3,"type":"heartRate"}"#, count: 3))
        for text in [result.title, result.detail] {
            #expect(!text.contains("{") && !text.contains("health.") && !text.contains(" ms") && !text.contains("Done"), "\(text)")
        }
    }

    @Test func daysGroupNewestFirstAsTodayYesterdayThenDates() {
        let entries = [
            entry(5, at: "2026-11-09T02:00:00Z", args: #"{"type":"stepCount"}"#),
            entry(4, at: "2026-11-09T01:00:00Z", args: #"{"type":"stepCount"}"#),
            entry(3, at: "2026-11-08T05:00:00Z", args: #"{"type":"stepCount"}"#),
            entry(2, at: "2026-11-07T05:00:00Z", args: #"{"type":"stepCount"}"#),
            entry(1, at: "2026-11-07T04:00:00Z", args: #"{"type":"stepCount"}"#),
        ]
        let days = formatter.days(entries)
        #expect(days.map(\.title) == ["Today", "Yesterday", "Nov 7"])
        #expect(days.map { $0.rows.map(\.id) } == [[5, 4], [3], [2, 1]])
        #expect(formatter.days([]).isEmpty)
    }

    @Test func aDayIsByThePhonesTimeZone() {
        // 20:00 UTC on the 8th is already the 9th in Shanghai.
        let days = formatter.days([entry(1, at: "2026-11-08T20:00:00Z", args: #"{"type":"stepCount"}"#)])
        #expect(days.first?.title == "Today")
    }

    @Test func everyTypeHasAReadableName() {
        for type in HealthTypes.all {
            let name = NodeActivityFormatter.typeName(type.name)
            #expect(name != type.name, "\(type.name) has no readable name")
        }
    }
}
