import EventKit
import Foundation

// The phone's calendars and reminders through EventKit, behind a protocol so
// the actions and the sync are tested with a fake. Every calendar on the
// phone counts, whichever account it comes from (iCloud, Google, Exchange).

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

struct ReminderItem: Equatable, Sendable {
    /// EventKit's `calendarItemIdentifier`.
    var id: String
    var title: String
    var notes: String?
    var list: String
    var listId: String
    var completed: Bool
    var completedAt: Date?
    var due: Date?
    /// The due date has no time of day.
    var dueAllDay: Bool = false
    /// 1 high to 9 low, 0 none.
    var priority: Int = 0
    var created: Date?
    var url: String?
}

/// A calendar or a reminders list.
struct CalendarListItem: Equatable, Sendable {
    enum Kind: String, Sendable { case events, reminders }
    var id: String
    var title: String
    var kind: Kind
    /// The account it belongs to, such as iCloud or Gmail.
    var account: String
    var writable: Bool
    var isDefault: Bool
}

/// Whether iOS lets the app read one kind.
enum CalendarAccessState: Equatable, Sendable {
    case granted
    case denied
    case notAsked
}

struct CalendarAccess: Equatable, Sendable {
    var events: CalendarAccessState
    var reminders: CalendarAccessState

    var any: Bool { events == .granted || reminders == .granted }
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

struct ReminderDraft: Equatable, Sendable {
    var title: String
    var due: Date?
    var dueAllDay = false
    var notes: String?
    /// A list's id or title; nil for the default list.
    var list: String?
    var priority: Int?
}

enum CalendarFailure: Error, Equatable {
    case denied(CalendarListItem.Kind)
    case notFound(String)
    case readOnly(String)
    case unknownList(String)
    case failed(String)
}

protocol CalendarReading: Sendable {
    func access() -> CalendarAccess
    /// iOS's own prompts, for each kind it never asked about.
    func requestAccess() async
    func events(in window: DateInterval) async throws -> [CalendarEventItem]
    /// Every open reminder, and those completed since `completedSince`.
    func reminders(completedSince: Date?) async throws -> [ReminderItem]
    func lists() async -> [CalendarListItem]
    func createEvent(_ draft: EventDraft) async throws -> CalendarEventItem
    func updateEvent(id: String, occurrence: Date?, changes: EventChanges) async throws -> CalendarEventItem
    func createReminder(_ draft: ReminderDraft) async throws -> ReminderItem
    func setCompleted(id: String, _ completed: Bool) async throws -> ReminderItem
}

/// EventKit, on one store. An actor, since `EKEventStore` is not thread-safe.
actor LiveCalendar: CalendarReading {
    private let store = EKEventStore()

    nonisolated func access() -> CalendarAccess {
        CalendarAccess(events: Self.state(.event), reminders: Self.state(.reminder))
    }

    private nonisolated static func state(_ type: EKEntityType) -> CalendarAccessState {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return .granted
        case .notDetermined: return .notAsked
        // Write-only cannot read, which the sync and every read need.
        default: return .denied
        }
    }

    func requestAccess() async {
        if Self.state(.event) == .notAsked { _ = try? await store.requestFullAccessToEvents() }
        if Self.state(.reminder) == .notAsked { _ = try? await store.requestFullAccessToReminders() }
        // A store made before access sees no calendars until it is reset.
        store.reset()
    }

    func events(in window: DateInterval) throws -> [CalendarEventItem] {
        guard Self.state(.event) == .granted else { throw CalendarFailure.denied(.events) }
        let predicate = store.predicateForEvents(withStart: window.start, end: window.end, calendars: nil)
        return store.events(matching: predicate).compactMap(Self.item)
    }

    func reminders(completedSince: Date?) async throws -> [ReminderItem] {
        guard Self.state(.reminder) == .granted else { throw CalendarFailure.denied(.reminders) }
        let open = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        var items = await fetch(open)
        if let completedSince {
            let done = store.predicateForCompletedReminders(withCompletionDateStarting: completedSince, ending: nil, calendars: nil)
            items += await fetch(done)
        }
        return items
    }

    private func fetch(_ predicate: NSPredicate) async -> [ReminderItem] {
        await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: (reminders ?? []).map(Self.item))
            }
        }
    }

    func lists() -> [CalendarListItem] {
        var lists: [CalendarListItem] = []
        if Self.state(.event) == .granted {
            let main = store.defaultCalendarForNewEvents?.calendarIdentifier
            lists += store.calendars(for: .event).map {
                CalendarListItem(id: $0.calendarIdentifier, title: $0.title, kind: .events, account: $0.source?.title ?? "", writable: $0.allowsContentModifications, isDefault: $0.calendarIdentifier == main)
            }
        }
        if Self.state(.reminder) == .granted {
            let main = store.defaultCalendarForNewReminders()?.calendarIdentifier
            lists += store.calendars(for: .reminder).map {
                CalendarListItem(id: $0.calendarIdentifier, title: $0.title, kind: .reminders, account: $0.source?.title ?? "", writable: $0.allowsContentModifications, isDefault: $0.calendarIdentifier == main)
            }
        }
        return lists
    }

    func createEvent(_ draft: EventDraft) throws -> CalendarEventItem {
        guard Self.state(.event) == .granted else { throw CalendarFailure.denied(.events) }
        let event = EKEvent(eventStore: store)
        event.calendar = try calendar(draft.calendar, for: .event)
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
        guard Self.state(.event) == .granted else { throw CalendarFailure.denied(.events) }
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

    func createReminder(_ draft: ReminderDraft) throws -> ReminderItem {
        guard Self.state(.reminder) == .granted else { throw CalendarFailure.denied(.reminders) }
        let reminder = EKReminder(eventStore: store)
        reminder.calendar = try calendar(draft.list, for: .reminder)
        reminder.title = draft.title
        reminder.notes = draft.notes
        if let priority = draft.priority { reminder.priority = priority }
        if let due = draft.due {
            var units: Set<Calendar.Component> = [.year, .month, .day]
            if !draft.dueAllDay { units.formUnion([.hour, .minute]) }
            reminder.dueDateComponents = Calendar.current.dateComponents(units, from: due)
            // A reminder with a time alerts then, as one made in Reminders does.
            if !draft.dueAllDay { reminder.addAlarm(EKAlarm(absoluteDate: due)) }
        }
        do { try store.save(reminder, commit: true) } catch { throw CalendarFailure.failed(error.localizedDescription) }
        return Self.item(reminder)
    }

    func setCompleted(id: String, _ completed: Bool) throws -> ReminderItem {
        guard Self.state(.reminder) == .granted else { throw CalendarFailure.denied(.reminders) }
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else { throw CalendarFailure.notFound(id) }
        reminder.isCompleted = completed
        do { try store.save(reminder, commit: true) } catch { throw CalendarFailure.failed(error.localizedDescription) }
        return Self.item(reminder)
    }

    /// The calendar a new item goes in: one named by id or title, else the default.
    private func calendar(_ name: String?, for type: EKEntityType) throws -> EKCalendar {
        guard let name, !name.isEmpty else {
            let main = type == .event ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders()
            guard let main else { throw CalendarFailure.unknownList("default") }
            return main
        }
        let all = store.calendars(for: type)
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

    private static func item(_ reminder: EKReminder) -> ReminderItem {
        let components = reminder.dueDateComponents
        return ReminderItem(
            id: reminder.calendarItemIdentifier,
            title: reminder.title ?? "",
            notes: reminder.notes?.nilIfEmpty,
            list: reminder.calendar?.title ?? "",
            listId: reminder.calendar?.calendarIdentifier ?? "",
            completed: reminder.isCompleted,
            completedAt: reminder.completionDate,
            due: components.flatMap { Calendar.current.date(from: $0) },
            dueAllDay: components.map { $0.hour == nil } ?? false,
            priority: reminder.priority,
            created: reminder.creationDate,
            url: reminder.url?.absoluteString
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
