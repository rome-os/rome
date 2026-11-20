#if DEBUG
import EventKit
import Foundation
import os

/// Test data for the Simulator, whose calendar starts empty: a few invented
/// events today and tomorrow. Debug builds only, and only
/// with the launch argument `-RomeSeedCalendar`, once per install.
///
/// `-RomeConnect <capability>` runs a connection's Connect with no tap, and
/// `-RomeRunNodeAction <action> <json args>` then runs one device operation
/// through the app's executor, as a Rome would over the Gateway, for a
/// Simulator signed in to a local Rome, which has no Gateway to reach it.
enum CalendarSeed {
    static var requested: Bool { ProcessInfo.processInfo.arguments.contains("-RomeSeedCalendar") }
    private static let doneKey = "calendarSeeded"
    private static let log = Logger(subsystem: "cc.romeos.mobile", category: "CalendarSeed")

    static func run() async {
        guard !UserDefaults.standard.bool(forKey: doneKey) else { return }
        let store = EKEventStore()
        guard (try? await store.requestFullAccessToEvents()) == true,
              let calendar = store.defaultCalendarForNewEvents
        else {
            log.error("calendar seed: no access")
            return
        }
        let today = Calendar.current.startOfDay(for: Date())
        func at(_ day: Int, _ hour: Double) -> Date {
            Calendar.current.date(byAdding: .day, value: day, to: today)!.addingTimeInterval(hour * 3600)
        }
        let events: [(String, Date, Date, String?)] = [
            ("Team standup", at(0, 10), at(0, 10.25), nil),
            ("Standup", at(1, 10), at(1, 10.5), nil),
            ("Design review", at(1, 14), at(1, 15), "Room 4"),
            ("Dentist", at(1, 16.5), at(1, 17.5), "Main Street clinic"),
            ("Planning", at(2, 11), at(2, 12), nil),
        ]
        for (title, start, end, location) in events {
            let event = EKEvent(eventStore: store)
            event.calendar = calendar
            event.title = title
            event.startDate = start
            event.endDate = end
            event.location = location
            try? store.save(event, span: .thisEvent, commit: false)
        }
        do {
            try store.commit()
            UserDefaults.standard.set(true, forKey: doneKey)
            log.info("calendar seed: \(events.count) events")
        } catch {
            log.error("calendar seed failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The operation and its args from `-RomeRunNodeAction`, if given.
    static var nodeAction: (action: String, args: String)? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-RomeRunNodeAction"), arguments.count > index + 2 else { return nil }
        return (arguments[index + 1], arguments[index + 2])
    }

    static func logReply(_ reply: String?) {
        log.info("node action reply: \(reply ?? "none", privacy: .public)")
    }
}
#endif
