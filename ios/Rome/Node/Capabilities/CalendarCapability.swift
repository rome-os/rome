import Foundation

/// Calendar & Reminders: one connection for both, since the guardian thinks
/// of them as one schedule and EventKit serves both. It asks iOS for full
/// access to each (two prompts), syncs events and reminders into the Rome's
/// personal data (`CalendarSync`), and reads and writes them live
/// (`CalendarActions`). It counts as connected while either kind is allowed;
/// an operation on the other says how to allow it.
struct CalendarCapability: NodeCapability {
    static let id = "apple_calendar"

    let actionsRunner: CalendarActions
    let live: NodeFlag

    init(actions: CalendarActions, live: NodeFlag) {
        actionsRunner = actions
        self.live = live
    }

    var id: String { Self.id }
    let prefix = "calendar"
    let name = "Calendar & Reminders"
    var title: LocalizedStringResource { "Calendar & Reminders" }
    let symbol = "calendar"
    var summary: LocalizedStringResource { "Your Rome reads your calendars and reminders, and adds or changes them when you ask." }
    var examples: [CapabilityExample] {
        [
            CapabilityExample(
                symbol: "sun.horizon", title: "Daily summary",
                request: "Summarize my day every morning.",
                reply: "Every morning at 8, I'll send today's schedule, what's due, and anything that needs you first."
            ),
            CapabilityExample(
                symbol: "clock", title: "Find free time",
                request: "Am I free tomorrow afternoon?",
                reply: "You're free from 2 to 4. Design review runs 4 to 5."
            ),
            CapabilityExample(
                symbol: "calendar.badge.plus", title: "Add it for you",
                request: "Put lunch with Sam on Friday at 12:30.",
                reply: "Added Lunch with Sam, Friday 12:30 to 1:30, to your calendar."
            ),
        ]
    }
    let personal = true
    let needsPermission = true
    var syncSource: String? { CalendarSync.sourceId }

    var actions: [NodeActionSpec] {
        let usage = CalendarActions.usage(actionsRunner.device)
        let reads = CalendarActions.reads.map {
            NodeActionSpec(name: $0, usage: usage[$0] ?? "", examples: CalendarActions.examples[$0] ?? [])
        }
        let writes = CalendarActions.writes.map {
            NodeActionSpec(name: $0, usage: usage[$0] ?? "", access: .write, examples: CalendarActions.examples[$0] ?? [])
        }
        return reads + writes
    }

    func permission() async -> NodePermission {
        let access = actionsRunner.reader.access()
        if access.any { return .granted }
        if access.events == .denied, access.reminders == .denied { return .denied }
        return .unknown
    }

    func requestPermission() async {
        await actionsRunner.reader.requestAccess()
    }

    func run(_ action: String, args: JSONValue?) async -> NodeActionResult {
        await actionsRunner.run(action, args: args)
    }

    // MARK: Activity

    func activityTitle(_ entry: NodeAuditEntry) -> String? {
        switch entry.action {
        case "calendar.events": return String(localized: "Events")
        case "calendar.free_busy": return String(localized: "Free and busy")
        case "calendar.lists": return String(localized: "Calendars and lists")
        case "calendar.reminders": return String(localized: "Reminders")
        case "calendar.create_event": return String(localized: "Added an event")
        case "calendar.update_event": return String(localized: "Changed an event")
        case "calendar.create_reminder": return String(localized: "Added a reminder")
        case "calendar.complete_reminder": return String(localized: "Completed a reminder")
        default: return nil
        }
    }

    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String? {
        switch entry.action {
        case "calendar.events", "calendar.free_busy":
            var parts = [formatter.window(entry, entry.argsValue)]
            if entry.action == "calendar.events", let count = entry.count { parts.append(String(localized: "\(count) events")) }
            return parts.joined(separator: " · ")
        case "calendar.reminders":
            return entry.count.map { String(localized: "\($0) reminders") }
        case "calendar.lists":
            return String(localized: "Read")
        default:
            return String(localized: "Done")
        }
    }
}
