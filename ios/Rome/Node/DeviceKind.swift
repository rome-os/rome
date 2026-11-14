import SwiftUI

/// What this device is called, in Settings and in what an agent reads. An iPad
/// works exactly as an iPhone does; only the word changes. Every screen and
/// message takes the word from here, never from a literal of its own.
enum DeviceKind: Sendable, Equatable {
    case iPhone
    case iPad

    /// From the interface idiom: an iPad says iPad, anything else iPhone.
    @MainActor static var current: DeviceKind {
        UIDevice.current.userInterfaceIdiom == .pad ? .iPad : .iPhone
    }

    /// The product name, the same in every language: for messages an agent reads.
    var name: String {
        switch self {
        case .iPhone: return "iPhone"
        case .iPad: return "iPad"
        }
    }

    var symbol: String {
        switch self {
        case .iPhone: return "iphone"
        case .iPad: return "ipad"
        }
    }

    /// Settings' group for this device.
    var groupTitle: LocalizedStringKey {
        switch self {
        case .iPhone: return "iPhone use"
        case .iPad: return "iPad use"
        }
    }

    var useSwitchTitle: LocalizedStringKey {
        switch self {
        case .iPhone: return "Can Rome use this iPhone"
        case .iPad: return "Can Rome use this iPad"
        }
    }
}
