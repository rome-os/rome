import Foundation
import Testing
@testable import Rome

/// Where a widget tap for an app lands (rome-os/rome#2118).
@Suite struct WidgetFollowTests {
    private let habits = InstalledApp(id: "habits", displayName: "Habits")

    /// A list read just now decides: the app, or the Apps grid with a notice.
    @Test func aFreshListDecides() {
        #expect(WidgetApps.decide("habits", fetched: [habits], shelfName: nil) == .found(habits))
        #expect(WidgetApps.decide("gone", fetched: [habits], shelfName: "Old") == .gone)
    }

    /// With no list to read (offline, a cold launch), the widget's own copy
    /// names the app and its page opens: never dropped.
    @Test func noListStillOpensTheApp() {
        #expect(WidgetApps.decide("habits", fetched: nil, shelfName: "Habits") == .found(InstalledApp(id: "habits", displayName: "Habits")))
        #expect(WidgetApps.decide("habits", fetched: nil, shelfName: nil) == .found(InstalledApp(id: "habits", displayName: nil)))
    }
}
