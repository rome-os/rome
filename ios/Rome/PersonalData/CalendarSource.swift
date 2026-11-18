import CryptoKit
import Foundation

// Calendar as a personal-data source: each run reads the phone's events from
// 7 days ago to 15 days ahead and sends them all as one snapshot of that
// window. The Rome replaces what it holds there once the last batch commits,
// so the phone keeps no record of what the Rome has: a lost answer is mended
// by the next run, and a run cut off leaves the last snapshot in place. An
// event that has aged out of the window stays on the Rome as history. A run
// that reads what the Rome last committed, window included, sends nothing,
// except once a day, so the Rome's copy never looks more than a day old.

struct CalendarSource: PersonalDataSource {
    static let pastDays = 7
    static let aheadDays = 15
    /// How long an unchanged calendar goes without a snapshot.
    static let resendAfter: TimeInterval = 86_400
    /// Notes are cut here: the Rome keeps at most 1,000 characters.
    static let notesLength = 1000
    static let maxAttendees = 20
    /// The Rome's own cuts: 200 characters for a text, 100 for each attendee.
    static let textLength = 200
    static let attendeeLength = 100
    /// Below the Rome's 4,096 characters of JSON per item, which it refuses
    /// whole: what goes past it is cut from the notes, then the attendees.
    static let itemLength = 4000
    /// The Rome refuses an entry longer than 366 days, and a refused event
    /// holds the whole calendar back from counting as synced: a longer one
    /// is sent as its part from the read window's start, cut to this, so
    /// what is stored still overlaps every day it was read for.
    static let maxEventLength: TimeInterval = 366 * 86_400

    let reader: CalendarReading
    let store: ProgressStoring
    var calendar: @Sendable () -> Calendar = { Calendar.current }
    let pending = PendingChunk()

    var id: String { CalendarSync.sourceId }

    func beginRun(trigger: SyncTrigger, instanceId: String, now: Date) async throws {
        var progress = await store.load()
        if progress.instanceId != instanceId { progress = SyncProgress(instanceId: instanceId) }
        guard reader.access() == .granted else { throw SourceReadFailure(code: "calendar_denied") }
        let calendar = calendar()
        let window = Self.window(now: now, calendar: calendar)
        // A day wider, then every event that touches the window, its edges
        // included: the Rome's commit deletes only what lies inside it, so it
        // never deletes an event the phone still has.
        let wide = DateInterval(start: window.start.addingTimeInterval(-86_400), end: window.end.addingTimeInterval(86_400))
        let events = try await read { try await reader.events(in: wide) }.filter { Self.touches($0, window) }
        let items = events.map { Self.point($0, window: window, calendar: calendar) }
        let chunk = Self.chunk(items, progress: progress, window: window, now: now)
        if let at = progress.snapshotAt, progress.snapshotDigest == chunk.snapshot?.digest,
           now >= at, now.timeIntervalSince(at) < Self.resendAfter {
            await pending.clear()
            return
        }
        await pending.set(chunk)
    }

    /// EventKit's refusals, as the sync history words them.
    private func read<T>(_ work: () async throws -> T) async throws -> T {
        do { return try await work() } catch CalendarFailure.denied {
            throw SourceReadFailure(code: "calendar_denied")
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SourceReadFailure(code: "calendar_failed")
        }
    }

    func nextChunk() async throws -> SyncChunk? {
        await pending.take()
    }

    func confirm(_ chunk: SyncChunk, unsupported: Set<String>, committed: Set<String>) async {
        // A Rome that does not know events keeps nothing: tried again next time.
        guard unsupported.isEmpty else { return }
        var commit = chunk.commit
        // Only a commit the Rome answered is one it holds: anything else is
        // sent whole next time.
        if committed.contains("events"), let snapshot = chunk.snapshot {
            commit.snapshotDigest = snapshot.digest
            commit.snapshotAt = snapshot.readAt
        } else {
            commit.snapshotDigest = nil
            commit.snapshotAt = nil
        }
        await store.save(commit)
    }

    func reset() async { await store.removeAll() }

    func historyCursor() async -> Date? { nil }

    // MARK: The chunk

    /// From 7 days before today's midnight to the end of the 15th day
    /// ahead: whole days, so the window moves once a day.
    static func window(now: Date, calendar: Calendar) -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -pastDays, to: today) ?? today
        let end = calendar.date(byAdding: .day, value: aheadDays + 1, to: today) ?? now
        return DateInterval(start: start, end: end)
    }

    /// Whether an event touches the window, either edge included.
    static func touches(_ event: CalendarEventItem, _ window: DateInterval) -> Bool {
        event.start <= window.end && max(event.end, event.start) >= window.start
    }

    /// Every event in the window, and the window itself, which the last
    /// batch commits.
    static func chunk(_ items: [PersonalDataPoint], progress: SyncProgress, window: DateInterval, now: Date) -> SyncChunk {
        var count = SyncTypeCount(items: 0, start: nil, end: nil)
        for item in items {
            count = SyncTypeCount(
                items: count.items + 1,
                start: [count.start, RomeDate.parse(item.start)].compactMap { $0 }.min(),
                end: [count.end, RomeDate.parse(item.end)].compactMap { $0 }.max()
            )
        }
        return SyncChunk(
            kind: .snapshot,
            upserts: items.sorted { $0.key < $1.key },
            marks: [.init(type: "events", syncedThrough: WireTime.string(now))],
            counts: ["events": count],
            snapshot: .init(
                id: UUID().uuidString.lowercased(), readAt: now, windows: ["events": window],
                digest: digest(items, window: window)
            ),
            commit: progress
        )
    }

    /// A digest of the window and every item in it, in key order.
    static func digest(_ items: [PersonalDataPoint], window: DateInterval) -> String {
        var hash = SHA256()
        hash.update(data: Data("\(WireTime.string(window.start))|\(WireTime.string(window.end))\n".utf8))
        for item in items.sorted(by: { $0.key < $1.key }) {
            hash.update(data: (try? PersonalDataClient.encoder.encode(item)) ?? Data(item.key.utf8))
            hash.update(data: Data("\n".utf8))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Items

    static func point(_ event: CalendarEventItem, window: DateInterval, calendar: Calendar) -> PersonalDataPoint {
        var key = "events:\(event.id)"
        func text(_ value: String) -> JSONValue { .string(String(value.prefix(textLength))) }
        var content: [String: JSONValue] = [
            "id": .string(event.id), "title": text(event.title), "calendar": text(event.calendar),
            "allDay": .bool(event.allDay), "availability": .string(event.availability), "status": .string(event.status),
        ]
        if let occurrence = event.occurrence {
            let at = WireTime.string(occurrence)
            key += "@\(at)"
            content["occurrence"] = .string(HealthDates.iso(occurrence, calendar))
            content["recurring"] = .bool(true)
        }
        if let location = event.location { content["location"] = text(location) }
        if let url = event.url { content["url"] = .string(String(url.prefix(500))) }
        var notes = event.notes.map { String($0.prefix(notesLength)) }
        var attendees = event.attendees.prefix(maxAttendees).map { String($0.prefix(attendeeLength)) }
        let realEnd = max(event.end, event.start)
        let start = realEnd.timeIntervalSince(event.start) > maxEventLength ? max(event.start, window.start) : event.start
        let end = min(realEnd, start.addingTimeInterval(maxEventLength))
        func build() -> PersonalDataPoint {
            var full = content
            if let notes, !notes.isEmpty { full["notes"] = .string(notes) }
            if !attendees.isEmpty { full["attendees"] = .array(attendees.map(JSONValue.string)) }
            return PersonalDataPoint(
                key: String(key.prefix(200)), type: "events", shape: .entry,
                start: WireTime.string(start), end: WireTime.string(end),
                tz: calendar.timeZone.identifier, content: full
            )
        }
        var point = build()
        while let over = overLength(point) {
            if let current = notes, !current.isEmpty {
                notes = String(current.prefix(max(0, current.count - over)))
            } else if !attendees.isEmpty {
                attendees.removeLast()
            } else {
                break
            }
            point = build()
        }
        return point
    }

    /// How many characters the item's JSON is past `itemLength`, counted
    /// as the Rome counts them (UTF-16 units), or nil when it fits.
    private static func overLength(_ point: PersonalDataPoint) -> Int? {
        guard let data = try? PersonalDataClient.encoder.encode(point),
              let json = String(data: data, encoding: .utf8)
        else { return nil }
        let over = json.utf16.count - itemLength
        return over > 0 ? over : nil
    }

}

/// The one chunk a run sends, held between `beginRun` and `nextChunk`.
actor PendingChunk {
    private var chunk: SyncChunk?

    func set(_ chunk: SyncChunk) { self.chunk = chunk }

    func clear() { chunk = nil }

    func take() -> SyncChunk? {
        defer { chunk = nil }
        return chunk
    }
}
