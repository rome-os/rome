import CryptoKit
import Foundation

// Calendar as a personal-data source: each run reads the phone's events from
// 7 days ago to 30 days ahead and sends what changed since the Rome last had
// it, with a delete for each one that is gone. An event that has aged out of
// the window is forgotten here and stays on the Rome as history.

struct CalendarSource: PersonalDataSource {
    static let pastDays = 7
    static let aheadDays = 30
    /// Notes are cut here: the Rome keeps at most 1,000 characters.
    static let notesLength = 1000
    static let maxAttendees = 20

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
        let items = try await read { try await reader.events(in: window) }.map { Self.point($0, calendar: calendar) }
        let chunk = Self.chunk(items, progress: progress, window: window, now: now)
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

    func confirm(_ chunk: SyncChunk, unsupported: Set<String>) async {
        // A Rome that refused events keeps nothing new: they are sent again next time.
        guard unsupported.isEmpty else { return }
        await store.save(chunk.commit)
    }

    func reset() async { await store.removeAll() }

    func historyCursor() async -> Date? { nil }

    // MARK: The chunk

    /// From 7 days before today's midnight to 30 days after now.
    static func window(now: Date, calendar: Calendar) -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -pastDays, to: today) ?? today
        let end = calendar.date(byAdding: .day, value: aheadDays, to: now) ?? now
        return DateInterval(start: start, end: end)
    }

    /// What changed against what the Rome holds: new and changed events, and
    /// deletes for the ones that are gone.
    static func chunk(_ items: [PersonalDataPoint], progress: SyncProgress, window: DateInterval, now: Date) -> SyncChunk {
        let old = progress.entries ?? [:]
        var next: [String: SyncProgress.SentEntry] = [:]
        var upserts: [PersonalDataPoint] = []
        var counts: [String: SyncTypeCount] = [:]
        for item in items {
            let hash = hash(item)
            let end = RomeDate.parse(item.end) ?? now
            next[item.key] = .init(hash: hash, end: end)
            guard old[item.key]?.hash != hash else { continue }
            upserts.append(item)
            let start = RomeDate.parse(item.start)
            let count = counts[item.type] ?? SyncTypeCount(items: 0, start: nil, end: nil)
            counts[item.type] = SyncTypeCount(
                items: count.items + 1,
                start: [count.start, start].compactMap { $0 }.min(),
                end: [count.end, end].compactMap { $0 }.max()
            )
        }
        var deletes: [String] = []
        for (key, entry) in old where next[key] == nil {
            // Aged out: the Rome keeps it as history, and nothing here tracks it.
            if entry.end < window.start { continue }
            deletes.append(key)
            let count = counts["events"] ?? SyncTypeCount(items: 0, start: nil, end: nil)
            counts["events"] = SyncTypeCount(items: count.items + 1, start: count.start, end: count.end)
        }
        var commit = progress
        commit.entries = next
        let through = WireTime.string(now)
        return SyncChunk(
            kind: .delta,
            upserts: upserts.sorted { $0.key < $1.key },
            deletes: deletes.sorted(),
            marks: [.init(type: "events", syncedThrough: through)],
            counts: counts,
            commit: commit
        )
    }

    static func hash(_ point: PersonalDataPoint) -> String {
        let data = (try? PersonalDataClient.encoder.encode(point)) ?? Data(point.key.utf8)
        return SHA256.hash(data: data).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Items

    static func point(_ event: CalendarEventItem, calendar: Calendar) -> PersonalDataPoint {
        var key = "events:\(event.id)"
        var content: [String: JSONValue] = [
            "id": .string(event.id), "title": .string(event.title), "calendar": .string(event.calendar),
            "allDay": .bool(event.allDay), "availability": .string(event.availability), "status": .string(event.status),
        ]
        if let occurrence = event.occurrence {
            let at = WireTime.string(occurrence)
            key += "@\(at)"
            content["occurrence"] = .string(HealthDates.iso(occurrence, calendar))
            content["recurring"] = .bool(true)
        }
        if let location = event.location { content["location"] = .string(location) }
        if let notes = event.notes { content["notes"] = .string(String(notes.prefix(notesLength))) }
        if !event.attendees.isEmpty { content["attendees"] = .array(event.attendees.prefix(maxAttendees).map(JSONValue.string)) }
        if let url = event.url { content["url"] = .string(String(url.prefix(500))) }
        return PersonalDataPoint(
            key: String(key.prefix(200)), type: "events", shape: .entry,
            start: WireTime.string(event.start), end: WireTime.string(max(event.end, event.start)),
            tz: calendar.timeZone.identifier, content: content
        )
    }

}

/// The one chunk a run sends, held between `beginRun` and `nextChunk`.
actor PendingChunk {
    private var chunk: SyncChunk?

    func set(_ chunk: SyncChunk) { self.chunk = chunk }

    func take() -> SyncChunk? {
        defer { chunk = nil }
        return chunk
    }
}
