import CryptoKit
import Foundation

// Calendar & Reminders as a personal-data source: each run reads the phone's
// events from 7 days ago to 30 days ahead, its open reminders and those
// completed in the last 7 days, and sends what changed since the Rome last
// had it, with a delete for each one that is gone. An event that has aged out
// of the window is forgotten here and stays on the Rome; a reminder that has
// left the set (deleted, or completed long ago) is deleted there.

struct CalendarSource: PersonalDataSource {
    static let pastDays = 7
    static let aheadDays = 30
    static let completedDays = 7
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
        let access = reader.access()
        guard access.any else { throw SourceReadFailure(code: "calendar_denied") }
        let calendar = calendar()
        let window = Self.window(now: now, calendar: calendar)
        var items: [PersonalDataPoint] = []
        var readTypes: Set<String> = []
        if access.events == .granted {
            items += try await read { try await reader.events(in: window) }.map { Self.point($0, calendar: calendar) }
            readTypes.insert("events")
        }
        if access.reminders == .granted {
            let since = now.addingTimeInterval(-Double(Self.completedDays) * 86_400)
            items += try await read { try await reader.reminders(completedSince: since) }
                .filter { !$0.completed || ($0.completedAt ?? .distantPast) >= since }
                .map { Self.point($0, now: now, calendar: calendar) }
            readTypes.insert("reminders")
        }
        let chunk = Self.chunk(items, read: readTypes, progress: progress, window: window, now: now)
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
        var progress = chunk.commit
        // A type the Rome refused keeps what it had: it is sent again next time.
        if !unsupported.isEmpty {
            let old = await store.load().entries ?? [:]
            var entries = progress.entries ?? [:]
            for key in entries.keys where unsupported.contains(Self.type(of: key)) { entries[key] = old[key] }
            for (key, entry) in old where unsupported.contains(Self.type(of: key)) { entries[key] = entry }
            progress.entries = entries
            progress.unsupported = unsupported
        }
        await store.save(progress)
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

    /// What changed against what the Rome holds: new and changed items, and
    /// deletes for the ones that are gone. `read`: the types this run could
    /// read; a type iOS no longer allows deletes nothing and keeps its record.
    static func chunk(_ items: [PersonalDataPoint], read: Set<String>, progress: SyncProgress, window: DateInterval, now: Date) -> SyncChunk {
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
            let type = type(of: key)
            if !read.contains(type) {
                next[key] = entry
            } else if type == "events", entry.end < window.start {
                // Aged out: the Rome keeps it as history, and nothing here tracks it.
                continue
            } else {
                deletes.append(key)
                let count = counts[type] ?? SyncTypeCount(items: 0, start: nil, end: nil)
                counts[type] = SyncTypeCount(items: count.items + 1, start: count.start, end: count.end)
            }
        }
        var commit = progress
        commit.entries = next
        let through = WireTime.string(now)
        return SyncChunk(
            kind: .delta,
            upserts: upserts.sorted { $0.key < $1.key },
            deletes: deletes.sorted(),
            marks: read.sorted().map { .init(type: $0, syncedThrough: through) },
            counts: counts,
            commit: commit
        )
    }

    static func type(of key: String) -> String {
        String(key.prefix { $0 != ":" })
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

    /// At its due time; one with no due date at when it was made.
    static func point(_ reminder: ReminderItem, now: Date, calendar: Calendar) -> PersonalDataPoint {
        let at = reminder.due ?? reminder.created ?? now
        var content: [String: JSONValue] = [
            "id": .string(reminder.id), "title": .string(reminder.title), "list": .string(reminder.list),
            "completed": .bool(reminder.completed), "hasDueDate": .bool(reminder.due != nil),
            "priority": .number(Double(reminder.priority)),
        ]
        if let notes = reminder.notes { content["notes"] = .string(String(notes.prefix(notesLength))) }
        if let done = reminder.completedAt { content["completedAt"] = .string(HealthDates.iso(done, calendar)) }
        if let url = reminder.url { content["url"] = .string(String(url.prefix(500))) }
        let time = WireTime.string(at)
        return PersonalDataPoint(
            key: String("reminders:\(reminder.id)".prefix(200)), type: "reminders", shape: .entry,
            start: time, end: time, tz: calendar.timeZone.identifier, content: content
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
