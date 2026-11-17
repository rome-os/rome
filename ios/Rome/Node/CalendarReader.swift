import EventKit
import Foundation

// The phone's calendars through EventKit, behind a protocol so the actions
// and the sync are tested with a fake. Every calendar on the phone counts,
// whichever account it comes from (iCloud, Google, Exchange).

/// One event, or one occurrence of a repeating one.
struct CalendarEventItem: Equatable, Sendable {
    /// EventKit's `eventIdentifier`: the same for every occurrence of a series.
    var id: String
    /// The occurrence's original start, for one of a repeating series: with
    /// the id it names that occurrence.
    var occurrence: Date?
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var location: String?
    var notes: String?
    var calendar: String
    var calendarId: String
    /// busy | free | tentative | unavailable | none
    var availability: String
    /// none | confirmed | tentative | canceled
    var status: String
    var attendees: [String] = []
    var url: String?

    var recurring: Bool { occurrence != nil }
}

/// One calendar on the phone.
struct CalendarListItem: Equatable, Sendable {
    var id: String
    var title: String
    /// The account it belongs to, such as iCloud or Gmail.
    var account: String
    var writable: Bool
    var isDefault: Bool
}

/// Whether iOS lets the app read the calendars.
enum CalendarAccessState: Equatable, Sendable {
    case granted
    case denied
    case notAsked
}

struct EventDraft: Equatable, Sendable {
    var title: String
    var start: Date
    var end: Date
    var allDay = false
    var location: String?
    var notes: String?
    var url: String?
    /// A calendar's id or title; nil for the default calendar.
    var calendar: String?
}

/// What an edit changes; nil keeps the field.
struct EventChanges: Equatable, Sendable {
    var title: String?
    var start: Date?
    var end: Date?
    var allDay: Bool?
    var location: String?
    var notes: String?
    /// The whole series from this occurrence on, not only this one.
    var future = false
}

enum CalendarFailure: Error, Equatable {
    case denied
    case notFound(String)
    case readOnly(String)
    case unknownList(String)
    case failed(String)
}

protocol CalendarReading: Sendable {
    func access() -> CalendarAccessState
    /// iOS's own prompt, when it never asked.
    func requestAccess() async
    func events(in window: DateInterval) async throws -> [CalendarEventItem]
    func lists() async -> [CalendarListItem]
    func createEvent(_ draft: EventDraft) async throws -> CalendarEventItem
    func updateEvent(id: String, occurrence: Date?, changes: EventChanges) async throws -> CalendarEventItem
}

/// EventKit, on one store. An actor, since `EKEventStore` is not thread-safe.
actor LiveCalendar: CalendarReading {
    private let store = EKEventStore()

    nonisolated func access() -> CalendarAccessState { Self.state() }

    private nonisolated static func state() -> CalendarAccessState {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return .granted
        case .notDetermined: return .notAsked
        // Write-only cannot read, which the sync and every read need.
        default: return .denied
        }
    }

    func requestAccess() async {
        if Self.state() == .notAsked { _ = try? await store.requestFullAccessToEvents() }
        // A store made before access sees no calendars until it is reset.
        store.reset()
    }

    func events(in window: DateInterval) throws -> [CalendarEventItem] {
        guard Self.state() == .granted else { throw CalendarFailure.denied }
        let predicate = store.predicateForEvents(withStart: window.start, end: window.end, calendars: nil)
        return store.events(matching: predicate).compactMap(Self.item)
    }

    func lists() -> [CalendarListItem] {
        guard Self.state() == .granted else { return [] }
        let main = store.defaultCalendarForNewEvents?.calendarIdentifier
        return store.calendars(for: .event).map {
            CalendarListItem(id: $0.calendarIdentifier, title: $0.title, account: $0.source?.title ?? "", writable: $0.allowsContentModifications, isDefault: $0.calendarIdentifier == main)
        }
    }

    func createEvent(_ draft: EventDraft) throws -> CalendarEventItem {
        guard Self.state() == .granted else { throw CalendarFailure.denied }
        let event = EKEvent(eventStore: store)
        event.calendar = try calendar(draft.calendar)
        event.title = draft.title
        event.startDate = draft.start
        event.endDate = draft.end
        event.isAllDay = draft.allDay
        event.location = draft.location
        event.notes = draft.notes
        event.url = draft.url.flatMap(URL.init(string:))
        do { try store.save(event, span: .thisEvent, commit: true) } catch { throw CalendarFailure.failed(error.localizedDescription) }
        guard let item = Self.item(event) else { throw CalendarFailure.failed("The event was saved without an id.") }
        return item
    }

    func updateEvent(id: String, occurrence: Date?, changes: EventChanges) throws -> CalendarEventItem {
        guard Self.state() == .granted else { throw CalendarFailure.denied }
        guard let event = find(id: id, occurrence: occurrence) else { throw CalendarFailure.notFound(id) }
        guard event.calendar.allowsContentModifications else { throw CalendarFailure.readOnly(event.calendar.title) }
        if let title = changes.title { event.title = title }
        if let allDay = changes.allDay { event.isAllDay = allDay }
        if let start = changes.start {
            // A new start alone keeps the event's length.
            let length = event.endDate.timeIntervalSince(event.startDate)
            event.startDate = start
            if changes.end == nil { event.endDate = start.addingTimeInterval(length) }
        }
        if let end = changes.end { event.endDate = end }
        if let location = changes.location { event.location = location.isEmpty ? nil : location }
        if let notes = changes.notes { event.notes = notes.isEmpty ? nil : notes }
        do {
            try store.save(event, span: changes.future ? .futureEvents : .thisEvent, commit: true)
        } catch {
            throw CalendarFailure.failed(error.localizedDescription)
        }
        guard let item = Self.item(event) else { throw CalendarFailure.failed("The event has no id.") }
        return item
    }

    /// One event, or the one occurrence of a series that started at `occurrence`.
    private func find(id: String, occurrence: Date?) -> EKEvent? {
        guard let occurrence else { return store.event(withIdentifier: id) }
        let predicate = store.predicateForEvents(withStart: occurrence.addingTimeInterval(-86_400), end: occurrence.addingTimeInterval(86_400), calendars: nil)
        return store.events(matching: predicate).first { $0.eventIdentifier == id && $0.occurrenceDate == occurrence }
            ?? store.event(withIdentifier: id)
    }

    /// The calendar a new event goes in: one named by id or title, else the default.
    private func calendar(_ name: String?) throws -> EKCalendar {
        guard let name, !name.isEmpty else {
            guard let main = store.defaultCalendarForNewEvents else { throw CalendarFailure.unknownList("default") }
            return main
        }
        let all = store.calendars(for: .event)
        guard let match = all.first(where: { $0.calendarIdentifier == name })
            ?? all.first(where: { $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame })
        else { throw CalendarFailure.unknownList(name) }
        guard match.allowsContentModifications else { throw CalendarFailure.readOnly(match.title) }
        return match
    }

    // MARK: Items

    private static func item(_ event: EKEvent) -> CalendarEventItem? {
        guard let id = event.eventIdentifier, let start = event.startDate, let end = event.endDate else { return nil }
        return CalendarEventItem(
            id: id,
            occurrence: event.hasRecurrenceRules ? event.occurrenceDate : nil,
            title: event.title ?? "",
            start: start,
            end: end,
            allDay: event.isAllDay,
            location: event.location?.nilIfEmpty,
            notes: event.notes?.nilIfEmpty,
            calendar: event.calendar?.title ?? "",
            calendarId: event.calendar?.calendarIdentifier ?? "",
            availability: availability(event.availability),
            status: status(event.status),
            attendees: (event.attendees ?? []).compactMap { $0.name?.nilIfEmpty },
            url: event.url?.absoluteString
        )
    }

    private static func availability(_ value: EKEventAvailability) -> String {
        switch value {
        case .busy: return "busy"
        case .free: return "free"
        case .tentative: return "tentative"
        case .unavailable: return "unavailable"
        default: return "none"
        }
    }

    private static func status(_ value: EKEventStatus) -> String {
        switch value {
        case .confirmed: return "confirmed"
        case .tentative: return "tentative"
        case .canceled: return "canceled"
        default: return "none"
        }
    }
}

extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
