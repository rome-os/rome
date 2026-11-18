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

    func access() -> CalendarAccessState { lock.withLock { accessState } }
    func requestAccess() async {}

    func events(in window: DateInterval) async throws -> [CalendarEventItem] {
        guard access() == .granted else { throw CalendarFailure.denied }
        return lock.withLock { events.filter { $0.start < window.end && $0.end > window.start } }
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

    @Test func sendsOnlyWhatChangedAndDeletesWhatIsGone() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10), CalendarFixtures.event("b", 14, 15)]
        let store = MemoryProgressStore()
        let source = source(fake, store)

        let first = try await run(source)
        #expect(first.upserts.map(\.key) == ["events:a", "events:b"])
        #expect(first.upserts.allSatisfy { $0.shape == .entry })
        #expect(first.marks.map(\.type) == ["events"])
        await source.confirm(first, unsupported: [], rejected: [])

        let same = try await run(source)
        #expect(same.upserts.isEmpty && same.deletes.isEmpty, "nothing changed")
        await source.confirm(same, unsupported: [], rejected: [])

        fake.events[0].title = "Moved"
        fake.events.remove(at: 1)
        let next = try await run(source)
        #expect(next.upserts.map(\.key) == ["events:a"])
        #expect(next.deletes == ["events:b"])
    }

    @Test func anEventSentInAnInterruptedRunIsStillDeletedWhenGone() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let store = MemoryProgressStore()
        let source = source(fake, store)
        await source.confirm(try await run(source), unsupported: [], rejected: [])
        // "b" goes out, but the run is cut off before the Rome confirms it.
        fake.events.append(CalendarFixtures.event("b", 14, 15))
        let cut = try await run(source)
        #expect(cut.upserts.map(\.key) == ["events:b"])
        // Then "b" is deleted on the phone.
        fake.events.removeLast()
        let next = try await run(source)
        #expect(next.deletes == ["events:b"], "the Rome may hold it")
        await source.confirm(next, unsupported: [], rejected: [])
        let after = try await run(source)
        #expect(after.deletes.isEmpty, "confirmed: nothing left to retry")
    }

    @Test func anUnconfirmedChangeIsSentAgainEvenWhenItLooksUnchanged() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let source = source(fake, MemoryProgressStore())
        await source.confirm(try await run(source), unsupported: [], rejected: [])
        // An edit goes out, and the run is cut off before the Rome confirms it.
        fake.events[0].title = "Moved"
        #expect(try await run(source).upserts.map(\.key) == ["events:a"])
        // Unchanged since that try: still sent, since the Rome may not have it.
        #expect(try await run(source).upserts.map(\.key) == ["events:a"])
    }

    @Test func aChangeRevertedAfterAnUnconfirmedTryIsSentAgain() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let source = source(fake, MemoryProgressStore())
        await source.confirm(try await run(source), unsupported: [], rejected: [])
        fake.events[0].title = "Moved"
        _ = try await run(source)
        // Back to what the Rome last confirmed, which it may have lost to the try.
        fake.events[0].title = "Event a"
        let next = try await run(source)
        #expect(next.upserts.map(\.key) == ["events:a"])
        await source.confirm(next, unsupported: [], rejected: [])
        #expect(try await run(source).upserts.isEmpty, "confirmed: nothing to resend")
    }

    @Test func anEventRestoredAfterAnUnconfirmedDeleteIsSentAgain() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let source = source(fake, MemoryProgressStore())
        await source.confirm(try await run(source), unsupported: [], rejected: [])
        // The delete goes out, and the Rome's answer is lost.
        let restored = fake.events.removeLast()
        #expect(try await run(source).deletes == ["events:a"])
        // Back as the Rome last confirmed it, which the delete may have removed.
        fake.events.append(restored)
        let next = try await run(source)
        #expect(next.upserts.map(\.key) == ["events:a"])
        #expect(next.deletes.isEmpty)
        await source.confirm(next, unsupported: [], rejected: [])
        #expect(try await run(source).upserts.isEmpty, "confirmed: nothing to resend")
    }

    @Test func anEventThatAgedOutIsForgottenNotDeleted() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10)]
        let source = source(fake)
        let first = try await run(source)
        await source.confirm(first, unsupported: [], rejected: [])
        let later = CalendarFixtures.now.addingTimeInterval(10 * 86_400)
        let after = try await run(source, at: later)
        #expect(after.deletes.isEmpty)
        #expect(after.commit.entries?["events:a"] == nil)
    }

    @Test func anEventTheRomeRefusedIsSentAgain() async throws {
        let fake = FakeCalendar()
        fake.events = [CalendarFixtures.event("a", 9, 10), CalendarFixtures.event("b", 14, 15)]
        let store = MemoryProgressStore()
        let source = source(fake, store)
        await source.confirm(try await run(source), unsupported: [], rejected: [])

        // b changes and the Rome refuses the new version: b keeps its old
        // hash, so it is sent again, and a later delete still follows it.
        fake.events[1].title = "Changed"
        await source.confirm(try await run(source), unsupported: [], rejected: ["events:b"])
        let again = try await run(source)
        #expect(again.upserts.map(\.key) == ["events:b"])

        // A new event the Rome refused is not remembered at all.
        fake.events.append(CalendarFixtures.event("c", 16, 17))
        await source.confirm(try await run(source), unsupported: [], rejected: ["events:b", "events:c"])
        #expect(try await run(source).upserts.map(\.key) == ["events:b", "events:c"])
    }

    @Test func aRefusalInAnEarlierBatchHoldsTheMarkBack() async throws {
        let fake = FakeCalendar()
        // More events than one batch carries: the refused one goes first.
        fake.events = (0...SyncEngine.maxItems).map { CalendarFixtures.event(String(format: "e%05d", $0), 9, 10) }
        let backend = FakePersonalDataBackend()
        await backend.refuse(keys: ["events:e00000"])
        let store = MemoryProgressStore()
        let engine = SyncEngine(
            source: source(fake, store),
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
        #expect(envelopes.last?.types.isEmpty == true, "events are not synced while one is refused")

        await backend.refuse(keys: [])
        await engine.sync(.manual)
        let retry = await backend.envelopes.dropFirst(2)
        #expect(retry.flatMap(\.upserts).map(\.key) == ["events:e00000"])
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
        await source.confirm(try await run(source), unsupported: ["events"], rejected: [])
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
