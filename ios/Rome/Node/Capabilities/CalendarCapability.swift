import Foundation

/// Calendar: every calendar on the phone, through EventKit. It asks iOS for
/// full access, syncs events into the Rome's personal data (`CalendarSync`),
/// and reads and writes them live (`CalendarActions`).
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
    let name = "Calendar"
    var title: LocalizedStringResource { "Calendar" }
    let symbol = "calendar"
    var cardIcon: String? { "calendar" }
    var summary: LocalizedStringResource { "Your Rome reads your calendars, and adds or changes events when you ask." }
    var examples: [CapabilityExample] {
        [
            CapabilityExample(
                symbol: "sun.horizon", title: "Daily summary",
                request: "Brief me every morning.",
                reply: "Every morning at 8, I'll send today's schedule and what needs you first."
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
        switch actionsRunner.reader.access() {
        case .granted: return .granted
        case .denied: return .denied
        case .notAsked: return .unknown
        }
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
        case "calendar.calendars": return String(localized: "Calendars")
        case "calendar.create_event": return String(localized: "Added an event")
        case "calendar.update_event": return String(localized: "Changed an event")
        default: return nil
        }
    }

    func activityDetail(_ entry: NodeAuditEntry, formatter: NodeActivityFormatter) -> String? {
        switch entry.action {
        case "calendar.events", "calendar.free_busy":
            var parts = [formatter.window(entry, entry.argsValue)]
            if entry.action == "calendar.events", let count = entry.count { parts.append(String(localized: "\(count) events")) }
            return parts.joined(separator: " · ")
        case "calendar.calendars":
            return String(localized: "Read")
        default:
            return String(localized: "Done")
        }
    }
}
