import Foundation
import Testing
@testable import Rome

/// A calendar in memory: invented events, no real person's data.
final class FakeCalendar: CalendarReading, @unchecked Sendable {
    private let lock = NSLock()
    var accessState = CalendarAccessState.granted
    var events: [CalendarEventItem] = []
    var created: [EventDraft] = []
    var updated: [(id: String, occurrence: Date?, changes: EventChanges)] = []
    /// Each window a sync asked for.
    var reads: [DateInterval] = []

    func access() -> CalendarAccessState { lock.withLock { accessState } }
    func requestAccess() async {}

    func events(in window: DateInterval) async throws -> [CalendarEventItem] {
        guard access() == .granted else { throw CalendarFailure.denied }
        return lock.withLock {
            reads.append(window)
            return events.filter { $0.start < window.end && $0.end > window.start }
        }
    }

    func lists() async -> [CalendarListItem] {
        [CalendarListItem(id: "cal-1", title: "Home", account: "iCloud", writable: true, isDefault: true)]
    }

    func createEvent(_ draft: EventDraft) async throws -> CalendarEventItem {
        lock.withLock { created.append(draft) }
        return CalendarEventItem(id: "new-1", title: draft.title, start: draft.start, end: draft.end, allDay: draft.allDay, calendar: "Home", calendarId: "cal-1", availability: "busy", status: "none")
    }

    func updateEvent(id: String, occurrence: Date?, changes: EventChanges) async throws -> CalendarEventItem {
        lock.withLock { updated.append((id, occurrence, changes)) }
        guard var event = lock.withLock({ events.first { $0.id == id } }) else { throw CalendarFailure.notFound(id) }
        // As LiveCalendar: a repeating event needs the occurrence.
        if occurrence == nil, event.occurrence != nil { throw CalendarFailure.needsOccurrence(id) }
        if let title = changes.title { event.title = title }
        if let start = changes.start { event.start = start }
        return event
    }

}

enum CalendarFixtures {
    static let zone = TimeZone(identifier: "Asia/Shanghai")!
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }
    /// 2026-11-17 09:00 in Shanghai.
    static let now = ISO8601DateFormatter().date(from: "2026-11-17T01:00:00Z")!

    /// Tomorrow at `hour` in Shanghai.
    static func tomorrow(_ hour: Double) -> Date {
        calendar.startOfDay(for: now).addingTimeInterval(86_400 + hour * 3600)
    }

    static func event(_ id: String, _ from: Double, _ to: Double, title: String? = nil, availability: String = "busy", allDay: Bool = false) -> CalendarEventItem {
        CalendarEventItem(id: id, title: title ?? "Event \(id)", start: tomorrow(from), end: tomorrow(to), allDay: allDay, calendar: "Home", calendarId: "cal-1", availability: availability, status: "confirmed")
    }

    static func actions(_ fake: FakeCalendar) -> CalendarActions {
        CalendarActions(reader: fake, now: { now }, calendar: { calendar })
    }
}

@Suite struct CalendarActionsTests {
    private func result(_ answer: NodeActionResult) throws -> JSONValue {
        guard case .ok(let value, _) = answer else { throw Failure(answer) }
        return value
    }

    struct Failure: Error { let answer: NodeActionResult; init(_ answer: NodeActionResult) { self.answer = answer } }

    @Test func eventsReadsTheWindowInThePhonesZone() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("b", 16, 17, title: "Design review"), CalendarFixtures.event("a", 9, 10)]
        let answer = try result(await CalendarFixtures.actions(fake).run("calendar.events", args: .object(["start": .string("2026-11-18"), "end": .string("2026-11-18")])))
        #expect(answer["startISO"]?.string == "2026-11-18T00:00:00+08:00")
        #expect(answer["endISO"]?.string == "2026-11-19T00:00:00+08:00")
        let events = try #require(answer["events"]?.array)
        #expect(events.map { $0["id"]?.string } == ["a", "b"])
        #expect(events[1]["start"]?.string == "2026-11-18T16:00:00+08:00")
        let found = try result(await CalendarFixtures.actions(fake).run("calendar.events", args: .object(["start": .string("2026-11-18"), "search": .string("REVIEW")])))
        #expect(found["events"]?.array?.map { $0["id"]?.string } == ["b"])
    }

    @Test func freeBusyMergesBusyTimeAndLeavesFreeAndAllDayApart() async throws {
        let fake = FakeCalendar()
        fake.events = [
            CalendarFixtures.event("a", 13, 14), CalendarFixtures.event("b", 13.5, 15),
            CalendarFixtures.event("c", 16, 17, availability: "free"),
            CalendarFixtures.event("trip", -24, 48, title: "Trip", allDay: true),
        ]
        let answer = try result(await CalendarFixtures.actions(fake).run("calendar.free_busy", args: .object(["start": .string("2026-11-18T12:00"), "end": .string("2026-11-18T18:00")])))
        let busy = try #require(answer["busy"]?.array)
        #expect(busy.count == 1)
        #expect(busy[0]["start"]?.string == "2026-11-18T13:00:00+08:00")
        #expect(busy[0]["end"]?.string == "2026-11-18T15:00:00+08:00")
        #expect(answer["free"]?.array?.map { $0["minutes"]?.number } == [60, 180])
        #expect(answer["allDay"]?.array?.map(\.string) == ["Trip"])
    }

    @Test func freeTimeKeepsToTheGivenHours() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 10, 11)]
        let answer = try result(await CalendarFixtures.actions(fake).run("calendar.free_busy", args: .object([
            "start": .string("2026-11-18"), "end": .string("2026-11-18"), "dayStart": .string("09:00"), "dayEnd": .string("12:00"),
        ])))
        let free = try #require(answer["free"]?.array)
        #expect(free.map { $0["start"]?.string } == ["2026-11-18T09:00:00+08:00", "2026-11-18T11:00:00+08:00"])
        #expect(free.map { $0["minutes"]?.number } == [60, 60])
    }

    /// Free time in New York on a daylight-saving day, between 09:00 and 17:00.
    private func freeOnAClockChange(_ date: String, dayEnd: String = "17:00") async throws -> [JSONValue] {
        var newYork = Calendar(identifier: .gregorian)
        newYork.timeZone = TimeZone(identifier: "America/New_York")!
        let calendar = newYork
        let actions = CalendarActions(reader: FakeCalendar(), now: { CalendarFixtures.now }, calendar: { calendar })
        let answer = try result(await actions.run("calendar.free_busy", args: .object([
            "start": .string(date), "end": .string(date), "dayStart": .string("09:00"), "dayEnd": .string(dayEnd),
        ])))
        return try #require(answer["free"]?.array)
    }

    @Test func freeTimeKeepsTheClockHoursWhenClocksGoForward() async throws {
        let free = try await freeOnAClockChange("2027-03-14")
        #expect(free.map { $0["start"]?.string } == ["2027-03-14T09:00:00-04:00"])
        #expect(free.map { $0["end"]?.string } == ["2027-03-14T17:00:00-04:00"])
    }

    @Test func freeTimeKeepsTheClockHoursWhenClocksGoBack() async throws {
        let free = try await freeOnAClockChange("2027-11-07")
        #expect(free.map { $0["start"]?.string } == ["2027-11-07T09:00:00-05:00"])
        #expect(free.map { $0["end"]?.string } == ["2027-11-07T17:00:00-05:00"])
    }

    @Test func freeTimeUntil24MeansTheNextMidnight() async throws {
        let free = try await freeOnAClockChange("2027-11-07", dayEnd: "24:00")
        #expect(free.map { $0["end"]?.string } == ["2027-11-08T00:00:00-05:00"])
        #expect(free.map { $0["minutes"]?.number } == [15 * 60])
    }

    @Test func createEventDefaultsToAnHourAndNeedsATitle() async throws {
        let fake = FakeCalendar()
        let actions = CalendarFixtures.actions(fake)
        let answer = try result(await actions.run("calendar.create_event", args: .object(["title": .string("Dentist"), "start": .string("2026-11-20T15:00")])))
        #expect(answer["event"]?["end"]?.string == "2026-11-20T16:00:00+08:00")
        #expect(fake.created.first?.allDay == false)
        let missing = await actions.run("calendar.create_event", args: .object(["start": .string("2026-11-20T15:00")]))
        #expect(missing == .failed(code: "invalid_args", message: "title is required."))
        #expect(fake.created.count == 1)
    }

    @Test func aDateAloneMakesAnAllDayEvent() async throws {
        let fake = FakeCalendar()
        _ = try result(await CalendarFixtures.actions(fake).run("calendar.create_event", args: .object(["title": .string("Holiday"), "start": .string("2026-11-20")])))
        let draft = try #require(fake.created.first)
        #expect(draft.allDay)
        #expect(draft.end.timeIntervalSince(draft.start) == 86_400)
    }

    @Test func updateEventNamesTheOccurrenceAndNeedsAChange() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let actions = CalendarFixtures.actions(fake)
        let none = await actions.run("calendar.update_event", args: .object(["id": .string("a")]))
        #expect(none == .failed(code: "invalid_args", message: "Send at least one field to change."))
        let moved = try result(await actions.run("calendar.update_event", args: .object([
            "id": .string("a"), "occurrence": .string("2026-11-18T09:00:00+08:00"), "start": .string("2026-11-18T11:00"),
        ])))
        #expect(moved["event"]?["start"]?.string == "2026-11-18T11:00:00+08:00")
        #expect(fake.updated.first?.occurrence == CalendarFixtures.tomorrow(9))
        let gone = await actions.run("calendar.update_event", args: .object(["id": .string("zzz"), "title": .string("x")]))
        guard case .failed(let code, _) = gone else { throw Failure(gone) }
        #expect(code == "not_found")
    }

    @Test func aRepeatingEventIsEditedOnlyByItsOccurrence() async throws {
        let fake = FakeCalendar()
        var standup = CalendarFixtures.event("s", 9, 10)
        standup.occurrence = CalendarFixtures.tomorrow(9)
        fake.events = [standup]
        let answer = await CalendarFixtures.actions(fake).run("calendar.update_event", args: .object([
            "id": .string("s"), "start": .string("2026-11-18T10:00"),
        ]))
        guard case .failed(let code, let message) = answer else { throw Failure(answer) }
        #expect(code == "invalid_args")
        #expect(message.contains("occurrence"))
    }

    @Test func aRefusalSaysWhereToAllowIt() async throws {
        let fake = FakeCalendar()
        fake.accessState = .denied
        let answer = await CalendarFixtures.actions(fake).run("calendar.events", args: nil)
        guard case .failed(let code, let message) = answer else { throw Failure(answer) }
        #expect(code == "permission_denied")
        #expect(message.contains("iOS Settings → Rome → Calendars"))
    }
}

@Suite struct CalendarCapabilityTests {
    @Test func writesAreReportedAsWritesAndSayWhenToRunThem() {
        let capability = CalendarCapability(actions: CalendarFixtures.actions(FakeCalendar()), live: NodeFlag(true))
        let operations = capability.actions.map(\.reportedOperation)
        let writes = operations.filter { $0.access == "write" }.map(\.name)
        #expect(writes == CalendarActions.writes)
        #expect(!writes.contains { $0.contains("delete") })
        for name in CalendarActions.writes {
            #expect(capability.actions.first { $0.name == name }?.usage.contains("only when the user asked for this change") == true)
        }
        #expect(capability.syncSource == "apple_calendar")
        #expect(capability.personal)
    }

    @Test func itsStateFollowsTheCalendarPermission() async {
        let fake = FakeCalendar()
        let capability = CalendarCapability(actions: CalendarFixtures.actions(fake), live: NodeFlag(true))
        #expect(await capability.permission() == .granted)
        #expect(await capability.state() == .on)
        fake.accessState = .denied
        #expect(await capability.permission() == .denied)
        fake.accessState = .notAsked
        #expect(await capability.permission() == .unknown)
        #expect(await capability.state() == .needsPermission)
    }

    @Test func itOffersNoReminders() {
        let capability = CalendarCapability(actions: CalendarFixtures.actions(FakeCalendar()), live: NodeFlag(true))
        #expect(capability.actions.allSatisfy { !$0.name.contains("remind") })
        #expect(capability.name == "Calendar")
    }

    @Test func itsExamplesStartWithTheDailySummary() {
        let capability = CalendarCapability(actions: CalendarFixtures.actions(FakeCalendar()), live: NodeFlag())
        #expect(capability.examples.count == 3)
        #expect(String(localized: capability.examples[0].title) == "Daily summary")
    }
}

@Suite struct CalendarSourceTests {
    private func run(_ source: CalendarSource, at now: Date = CalendarFixtures.now) async throws -> SyncChunk {
        try await source.beginRun(trigger: .foreground, instanceId: "inst-1", now: now)
        return try #require(await source.nextChunk())
    }

    private func source(_ fake: FakeCalendar, _ store: ProgressStoring = MemoryProgressStore()) -> CalendarSource {
        CalendarSource(reader: fake, store: store, calendar: { CalendarFixtures.calendar })
    }

    @Test func sendsEveryEventInTheWindowAsOneSnapshot() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("b", 14, 15), CalendarFixtures.event("a", 9, 10)]
        let source = source(fake)

        let first = try await run(source)
        #expect(first.kind == .snapshot)
        #expect(first.upserts.map(\.key) == ["events:a", "events:b"])
        #expect(first.upserts.allSatisfy { $0.shape == .entry })
        #expect(first.deletes.isEmpty, "the Rome deletes what a snapshot leaves out")
        #expect(first.marks.map(\.type) == ["events"])
        let snapshot = try #require(first.snapshot)
        #expect(snapshot.windows == ["events": window])
        #expect(snapshot.readAt == CalendarFixtures.now)
        // An older Rome commits nothing.
        await source.confirm(first, unsupported: [], committed: [])

        // Unchanged, it is all sent again, under a new id: only a commit the
        // Rome answered lets a run skip.
        let same = try await run(source)
        #expect(same.upserts.map(\.key) == ["events:a", "events:b"])
        #expect(same.snapshot?.id != snapshot.id)

        fake.events.removeLast()
        #expect(try await run(source).upserts.map(\.key) == ["events:b"])
    }

    private func engine(_ fake: FakeCalendar, _ backend: FakePersonalDataBackend, _ clock: Clock) -> SyncEngine {
        SyncEngine(
            source: source(fake),
            target: { PersonalDataTarget(instanceId: "inst-1", backend: backend) },
            log: MemorySyncLog(),
            origin: { .init(id: "origin-1", name: "iPhone", platform: "ios", appVersion: "1.6.0") },
            switches: { SyncSwitches(enabled: true) },
            protectedData: { true },
            now: { clock.now },
            random: { 0.5 },
            pause: { _ in try await Task.sleep(for: .seconds(3600)) }
        )
    }

    @Test func anUnchangedCalendarSendsNothingUntilItChangesOrTheDayTurns() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let backend = FakePersonalDataBackend()
        let clock = Clock(CalendarFixtures.now)
        let engine = engine(fake, backend, clock)
        await engine.sync(.manual)
        #expect(await backend.envelopes.count == 1)

        clock.advance(3600)
        await engine.sync(.manual)
        #expect(await backend.envelopes.count == 1, "the Rome has this snapshot already")

        fake.events[0].title = "Moved"
        await engine.sync(.manual)
        #expect(await backend.envelopes.count == 2, "a change sends it all again")

        // 09:00 in Shanghai plus 16 hours: past midnight, the window moves on.
        clock.advance(16 * 3600)
        await engine.sync(.manual)
        let envelopes = await backend.envelopes
        #expect(envelopes.count == 3, "a new day sends the snapshot again")
        #expect(envelopes.last?.upserts.map(\.key) == ["events:a"])
    }

    @Test func aLostCommitAnswerSendsTheSnapshotAgain() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let backend = FakePersonalDataBackend()
        let clock = Clock(CalendarFixtures.now)
        let engine = engine(fake, backend, clock)
        await backend.loseAnswer()
        await engine.sync(.manual)
        #expect(await backend.envelopes.count == 1, "it reached the Rome, its answer did not come back")

        clock.advance(60)
        await engine.sync(.manual)
        #expect(await backend.envelopes.count == 2, "sent whole again")
        clock.advance(60)
        await engine.sync(.manual)
        #expect(await backend.envelopes.count == 2, "committed and answered: skipped")
    }

    @Test func theWindowIsWholeDaysFifteenAhead() {
        let window = CalendarSource.window(now: CalendarFixtures.now, calendar: CalendarFixtures.calendar)
        let today = CalendarFixtures.calendar.startOfDay(for: CalendarFixtures.now)
        #expect(window.start == today.addingTimeInterval(-7 * 86_400))
        #expect(window.end == today.addingTimeInterval(16 * 86_400))
        let later = CalendarSource.window(now: CalendarFixtures.now.addingTimeInterval(3600), calendar: CalendarFixtures.calendar)
        #expect(later == window, "the same all day")
    }

    @Test func anEmptyCalendarIsAnEmptySnapshot() async throws {
        let chunk = try await run(source(FakeCalendar()))
        #expect(chunk.upserts.isEmpty)
        #expect(chunk.snapshot?.windows["events"] == window)
        #expect(SyncEngine.batches(chunk).count == 1, "one batch still carries the commit")
    }

    @Test func anEventTouchingAnEdgeIsSentSoTheCommitKeepsIt() async throws {
        let fake = FakeCalendar()
        func event(_ id: String, _ start: Date, _ end: Date) -> CalendarEventItem {
            var event = CalendarFixtures.event(id, 9, 10)
            event.start = start
            event.end = end
            return event
        }
        let hour: TimeInterval = 3600
        fake.events = [
            event("straddles", window.start.addingTimeInterval(-hour), window.start.addingTimeInterval(hour)),
            event("ends-at-start", window.start.addingTimeInterval(-hour), window.start),
            event("starts-at-end", window.end, window.end.addingTimeInterval(hour)),
            event("before", window.start.addingTimeInterval(-3 * hour), window.start.addingTimeInterval(-hour)),
            event("after", window.end.addingTimeInterval(hour), window.end.addingTimeInterval(2 * hour)),
        ]
        let chunk = try await run(source(fake))
        #expect(chunk.upserts.map(\.key) == ["events:ends-at-start", "events:starts-at-end", "events:straddles"])
        #expect(fake.reads.first.map { $0.start < window.start && $0.end > window.end } == true, "read wider than the window")
    }

    @Test func progressSavedWithTheOldLedgerStillLoads() throws {
        let saved = #"{"instanceId":"inst-1","anchors":{},"sleepNights":{},"syncedThrough":{},"unsupported":[],"entries":{"events:a":{"hash":"ab","end":0}},"attempted":{}}"#
        let progress = try JSONDecoder().decode(SyncProgress.self, from: Data(saved.utf8))
        #expect(progress.instanceId == "inst-1")
    }

    @Test func aRefusalInAnyBatchLeavesTheWindowOutOfTheCommit() async throws {
        let fake = FakeCalendar()
        // More events than one batch carries: the refused one goes first.
        fake.events = (0...SyncEngine.maxItems).map { CalendarFixtures.event(String(format: "e%05d", $0), 9, 10) }
        let backend = FakePersonalDataBackend()
        await backend.refuse(keys: ["events:e00000"])
        let engine = SyncEngine(
            source: source(fake),
            target: { PersonalDataTarget(instanceId: "inst-1", backend: backend) },
            log: MemorySyncLog(),
            origin: { .init(id: "origin-1", name: "iPhone", platform: "ios", appVersion: "1.6.0") },
            switches: { SyncSwitches(enabled: true) },
            protectedData: { true },
            now: { CalendarFixtures.now },
            random: { 0.5 },
            pause: { _ in try await Task.sleep(for: .seconds(3600)) }
        )
        await engine.sync(.manual)
        let envelopes = await backend.envelopes
        #expect(envelopes.count == 2)
        let id = try #require(envelopes.first?.snapshot?.id)
        #expect(envelopes.allSatisfy { $0.snapshot?.id == id }, "every batch carries the snapshot")
        #expect(envelopes.first?.snapshot?.windows == nil, "only the last batch commits")
        #expect(envelopes.last?.snapshot?.windows == [], "a refused event holds the commit back")
        #expect(envelopes.last?.types.isEmpty == true)

        await backend.refuse(keys: [])
        await engine.sync(.manual)
        let retry = Array(await backend.envelopes.dropFirst(2))
        #expect(retry.flatMap(\.upserts).count == SyncEngine.maxItems + 1, "the whole window again")
        #expect(retry.last?.snapshot?.windows?.map(\.type) == ["events"])
        #expect(retry.last?.types.map(\.type) == ["events"])
    }

    private var window: DateInterval { CalendarSource.window(now: CalendarFixtures.now, calendar: CalendarFixtures.calendar) }

    @Test func aLongRunningEventKeepsThePartThatWasRead() {
        let day: TimeInterval = 86_400
        var event = CalendarFixtures.event("long", 9, 10)
        event.start = CalendarFixtures.now.addingTimeInterval(-400 * day)
        event.end = CalendarFixtures.now.addingTimeInterval(20 * day)
        let point = CalendarSource.point(event, window: window, calendar: CalendarFixtures.calendar)
        #expect(point.start == WireTime.string(window.start))
        #expect(point.end == WireTime.string(event.end), "still running: its real end is kept")

        // A short event keeps its own start, even one before the window.
        var short = CalendarFixtures.event("short", 9, 10)
        short.start = window.start.addingTimeInterval(-day)
        short.end = window.start.addingTimeInterval(day)
        #expect(CalendarSource.point(short, window: window, calendar: CalendarFixtures.calendar).start == WireTime.string(short.start))
    }

    @Test func aLongEventFitsTheRomesItemLimit() throws {
        var event = CalendarFixtures.event("a", 9, 10, title: String(repeating: "t", count: 500))
        event.location = String(repeating: "l", count: 500)
        event.notes = String(repeating: "\"n\"", count: 400)
        event.attendees = (0..<20).map { "\($0)" + String(repeating: "会", count: 200) }
        let point = CalendarSource.point(event, window: window, calendar: CalendarFixtures.calendar)
        let json = try #require(String(data: try PersonalDataClient.encoder.encode(point), encoding: .utf8))
        #expect(json.utf16.count <= CalendarSource.itemLength)
        #expect(point.content?["title"]?.string?.count == CalendarSource.textLength)
        #expect(point.content?["location"]?.string?.count == CalendarSource.textLength)
        #expect(point.content?["attendees"]?.array?.isEmpty == false, "attendees kept once the notes are cut")
    }

    @Test func aRefusedBatchKeepsTheOldRecord() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let store = MemoryProgressStore()
        let source = source(fake, store)
        await source.confirm(try await run(source), unsupported: ["events"], committed: [])
        let again = try await run(source)
        #expect(again.upserts.map(\.key) == ["events:a"], "sent again after the Rome refused it")
    }

    @Test func noAccessAtAllFailsWithItsOwnCode() async {
        let fake = FakeCalendar()
        fake.accessState = .denied
        await #expect(throws: SourceReadFailure(code: "calendar_denied")) {
            try await source(fake).beginRun(trigger: .manual, instanceId: "inst-1", now: CalendarFixtures.now)
        }
    }

    @Test func aRepeatingEventsOccurrencesAreEntriesOfTheirOwn() {
        var event = CalendarFixtures.event("s", 9, 10)
        event.occurrence = CalendarFixtures.tomorrow(9)
        let point = CalendarSource.point(event, window: window, calendar: CalendarFixtures.calendar)
        #expect(point.key == "events:s@2026-11-18T01:00:00Z")
        #expect(point.content?["occurrence"]?.string == "2026-11-18T09:00:00+08:00")
        #expect(point.content?["recurring"]?.bool == true)
    }
}

@Suite struct ConnectCardWordsTests {
    @Test func eachConnectionReportsItsPageWordsInEveryLanguage() async throws {
        let registry = NodeCapabilityRegistry(capabilities: [
            CalendarCapability(actions: CalendarFixtures.actions(FakeCalendar()), live: NodeFlag(true)),
        ])
        let connection = try #require(await registry.connections().first)
        #expect(connection.summary == "Your Rome reads your calendars, and adds or changes events when you ask.")
        #expect(connection.labels?["en"]?.title == "Calendar")
        let chinese = try #require(connection.labels?["zh-CN"])
        #expect(chinese.title == "日历")
        #expect(chinese.summary != connection.summary, "in Chinese, whatever the phone's language")
        #expect(connection.icon == "calendar")
    }

    @MainActor @Test func romeWordsFallBackToTheCardsEnglish() {
        let words: JSONValue = .object(["connect": .string("Connect"), "someday": .string("Someday")])
        let localized = WidgetSurface.withRomeWords(words)
        #expect(localized["connect"]?.string == String(localized: "Connect"))
        #expect(localized["someday"]?.string == "Someday", "a word this app does not know keeps the English")
    }

    @Test func theDeviceCardsRomeStringsHaveWords() {
        for name in ["connect", "notNow", "deviceConnectNote"] {
            #expect(!WidgetPaths.hostString(name).isEmpty, "no words for \(name)")
        }
    }
}
