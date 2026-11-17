import AVFoundation
import Foundation

/// A microphone the phone can record from, named as iOS names it.
struct MicrophoneOption: Identifiable, Hashable {
    /// The input's port UID, which stays the same each time it connects.
    let id: String
    let name: String
}

/// The microphones iOS lists, and whether the list is complete. iOS lists
/// every input only on an active session, so a list from an inactive one may
/// leave out a microphone that is still connected.
struct MicrophoneList {
    let options: [MicrophoneOption]
    let complete: Bool
}

/// Which microphone voice input records from, kept on this phone. Nil is the
/// system default, which follows iOS's own audio route.
struct MicrophoneChoice {
    static let key = "voiceInput.microphone"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The chosen microphone's port UID; nil for the system default.
    var chosen: String? {
        get { defaults.string(forKey: Self.key).flatMap { $0.isEmpty ? nil : $0 } }
        nonmutating set {
            if let newValue { defaults.set(newValue, forKey: Self.key) } else { defaults.removeObject(forKey: Self.key) }
        }
    }

    /// The input to record from among `inputs`: the chosen one while it is
    /// connected, otherwise nil, which leaves the system default.
    func preferred<Input>(among inputs: [Input], uid: (Input) -> String) -> Input? {
        guard let chosen else { return nil }
        return inputs.first { uid($0) == chosen }
    }

    /// Switches the choice to the system default when the chosen microphone
    /// is not among the connected `ids`, and returns the choice that holds.
    /// An empty list is iOS not having answered yet, not every input gone.
    @discardableResult
    func settle(connected ids: [String]) -> String? {
        if let chosen, !ids.isEmpty, !ids.contains(chosen) { self.chosen = nil }
        return chosen
    }

    /// The choice after Settings lists the microphones. A complete list
    /// without the chosen microphone switches the choice to the system
    /// default, which stays chosen when that microphone comes back. An
    /// incomplete list leaves the choice as it is.
    @discardableResult
    func settle(_ list: MicrophoneList) -> String? {
        list.complete ? settle(connected: list.options.map(\.id)) : chosen
    }

    /// The choice after iOS reports a route change while voice input listens,
    /// with `connected` read from the active session, which lists every
    /// input. A microphone taken off switches the choice to the system
    /// default, which stays chosen when that microphone comes back.
    @discardableResult
    func routeChanged(_ reason: AVAudioSession.RouteChangeReason?, connected ids: [String]) -> String? {
        reason == .oldDeviceUnavailable ? settle(connected: ids) : chosen
    }

    /// Sets the audio session to record, as voice input does, so that iOS
    /// lists every input, Bluetooth headsets included. Does not activate it.
    @MainActor
    static func prepare(_ session: AVAudioSession = .sharedInstance()) throws {
        try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
    }

    /// The microphones iOS can record from now. Leaves the session as it
    /// found it, so that showing the list changes no other audio.
    @MainActor
    static func available(_ session: AVAudioSession = .sharedInstance()) -> MicrophoneList {
        if MicrophoneSource.capturing {
            return MicrophoneList(options: inputs(of: session), complete: true)
        }
        let category = session.category
        let mode = session.mode
        let options = session.categoryOptions
        let listsEveryInput = category == .record && options.contains(.allowBluetooth)
        if !listsEveryInput { try? prepare(session) }
        // Activating a session that records stops other apps' audio and asks
        // for the microphone, so Settings activates it only when neither happens.
        let activated = AVAudioApplication.shared.recordPermission == .granted
            && !session.isOtherAudioPlaying
            && (try? session.setActive(true)) != nil
        defer {
            if activated { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
            if !listsEveryInput { try? session.setCategory(category, mode: mode, options: options) }
        }
        return MicrophoneList(options: inputs(of: session), complete: activated)
    }

    @MainActor
    private static func inputs(of session: AVAudioSession) -> [MicrophoneOption] {
        (session.availableInputs ?? []).map { MicrophoneOption(id: $0.uid, name: $0.portName) }
    }

    /// Points the session at the chosen microphone, or back at the system
    /// default when none is chosen. Call it on an active session: iOS takes a
    /// preferred input only then, and lists every input only then. A chosen
    /// microphone that is unplugged switches the choice to the system default.
    @MainActor
    func apply(to session: AVAudioSession = .sharedInstance()) {
        let inputs = session.availableInputs ?? []
        settle(connected: inputs.map(\.uid))
        let port = preferred(among: inputs, uid: \.uid)
        // A refused preference leaves iOS's own route, the system default.
        try? session.setPreferredInput(port)
    }
}
