import AVFoundation
import Foundation

/// A microphone the phone can record from, named as iOS names it.
struct MicrophoneOption: Identifiable, Hashable {
    /// The input's port UID, which stays the same each time it connects.
    let id: String
    let name: String
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

    /// Sets the audio session to record, as voice input does, so that iOS
    /// lists every input, Bluetooth headsets included. Does not activate it.
    @MainActor
    static func prepare(_ session: AVAudioSession = .sharedInstance()) throws {
        try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
    }

    /// The microphones iOS can record from now.
    @MainActor
    static func available(_ session: AVAudioSession = .sharedInstance()) -> [MicrophoneOption] {
        try? prepare(session)
        return (session.availableInputs ?? []).map { MicrophoneOption(id: $0.uid, name: $0.portName) }
    }

    /// Points the session at the chosen microphone, or back at the system
    /// default when none is chosen. A chosen microphone that is unplugged
    /// switches the choice to the system default, as Settings shows.
    @MainActor
    func apply(to session: AVAudioSession = .sharedInstance()) {
        let inputs = session.availableInputs ?? []
        settle(connected: inputs.map(\.uid))
        let port = preferred(among: inputs, uid: \.uid)
        // A refused preference leaves iOS's own route, the system default.
        try? session.setPreferredInput(port)
    }
}
