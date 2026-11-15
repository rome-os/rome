import CoreLocation
import Foundation

// The share-location card's client side, as the web dashboard's card runs it:
// core draws the card and decides what its events mean; the app reads the
// phone's position when Share is pressed and sends it with the event. The
// position is read once, with When In Use permission, and kept nowhere.

/// The share-location card core owns (`@rome/api-types/location-card`).
enum LocationCard {
    /// The event Share fires: the one event the app fills in itself.
    nonisolated static let shareEvent = "share-location"

    /// Whether a card is the share-location card: core's own, holding the
    /// Share event. An app's card that names the same event is not, so it
    /// gets no position and never shares by itself.
    nonisolated static func isLocationCard(_ part: WidgetUIPart) -> Bool {
        part.appId == "core"
            && part.components.contains { $0["action"]?["event"]?["name"]?.string == shareEvent }
    }

    /// Whether core marked the card as one the app may answer by itself where
    /// it already may read the position (`autoShare` in the card's data).
    nonisolated static func mayAutoShare(_ part: WidgetUIPart) -> Bool {
        part.data["autoShare"]?.bool == true
    }

    /// How an answered card ended: shared, with how precise the position
    /// was, or not shared (declined, or skipped by a message).
    nonisolated static func outcome(_ answered: JSONValue) -> String {
        if answered["status"]?.string == "shared", let meters = answered["accuracyMeters"]?.number {
            return String(localized: "Location shared · ±\(accuracyText(meters))")
        }
        return String(localized: "Not shared")
    }

    /// The accuracy radius: meters under a kilometer, whole kilometers above.
    nonisolated static func accuracyText(_ meters: Double) -> String {
        meters < 1000 ? "\(Int(meters.rounded())) m" : "\(Int((meters / 1000).rounded())) km"
    }

    /// Why no position was sent, for the card to show.
    nonisolated static func failureText(_ failure: LocationFailure) -> String {
        switch failure {
        case .denied:
            String(localized: "Location access is off for Rome. Turn it on in Settings, or tap Not now.")
        case .unavailable:
            String(localized: "Couldn't find your location. Try again, or tap Not now.")
        }
    }
}

/// A position read from the phone, as the Share event carries it.
struct SharedPosition: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    /// The radius of the fix, in meters.
    let accuracy: Double
    let takenAt: Date

    var json: JSONValue {
        .object([
            "latitude": .number(latitude),
            "longitude": .number(longitude),
            "accuracy": .number(accuracy),
            "timestamp": .number((takenAt.timeIntervalSince1970 * 1000).rounded()),
        ])
    }
}

enum LocationFailure: Error, Equatable, Sendable {
    /// The guardian or the system refused location access.
    case denied
    /// No fix came.
    case unavailable
}

/// Whether the app may read the phone's position now.
enum LocationPermission: Equatable, Sendable {
    /// While Using, or an Allow Once still in force.
    case granted
    case denied
    /// iOS has not asked yet, or an Allow Once has lapsed.
    case undetermined
}

/// Reads the phone's position once.
@MainActor
protocol DeviceLocating: AnyObject {
    var permission: LocationPermission { get }
    func currentPosition() async -> Result<SharedPosition, LocationFailure>
}

/// CoreLocation with When In Use permission, asked for on the first Share.
/// iOS's own prompt offers Allow Once and While Using the App.
@MainActor
final class CoreLocationLocator: NSObject, DeviceLocating, CLLocationManagerDelegate {
    static let shared = CoreLocationLocator()

    private let manager = CLLocationManager()
    private var authorized: [CheckedContinuation<Void, Never>] = []
    private var fixes: [CheckedContinuation<Result<SharedPosition, LocationFailure>, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var permission: LocationPermission {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: .granted
        case .notDetermined: .undetermined
        default: .denied
        }
    }

    func currentPosition() async -> Result<SharedPosition, LocationFailure> {
        if manager.authorizationStatus == .notDetermined {
            await withCheckedContinuation { authorized.append($0); manager.requestWhenInUseAuthorization() }
        }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: break
        default: return .failure(.denied)
        }
        return await withCheckedContinuation { continuation in
            fixes.append(continuation)
            if fixes.count == 1 { manager.requestLocation() }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let decided = manager.authorizationStatus != .notDetermined
        MainActor.assumeIsolated {
            guard decided else { return }
            let waiting = authorized
            authorized = []
            waiting.forEach { $0.resume() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let position = locations.last.flatMap { fix in
            fix.horizontalAccuracy < 0 ? nil : SharedPosition(
                latitude: fix.coordinate.latitude,
                longitude: fix.coordinate.longitude,
                accuracy: fix.horizontalAccuracy,
                takenAt: fix.timestamp
            )
        }
        MainActor.assumeIsolated { finish(position.map { .success($0) } ?? .failure(.unavailable)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        MainActor.assumeIsolated { finish(.failure(denied ? .denied : .unavailable)) }
    }

    private func finish(_ result: Result<SharedPosition, LocationFailure>) {
        let waiting = fixes
        fixes = []
        waiting.forEach { $0.resume(returning: result) }
    }
}
