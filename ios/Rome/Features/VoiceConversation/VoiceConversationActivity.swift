#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif

/// Where a running voice conversation shows outside the app: the Lock Screen
/// and the Dynamic Island. Tests stand in for it.
@MainActor
protocol VoiceConversationPresence: AnyObject {
    /// The conversation started: it shows until `hide`.
    func show()
    /// The conversation ended, however it ended.
    func hide()
}

/// The Live Activity the widget draws (`VoiceConversationLiveActivity`): Rome's
/// mascot and a still wave. Nothing shows where the guardian turned Live
/// Activities off, or on Mac Catalyst.
@MainActor
final class VoiceConversationLiveActivityPresence: VoiceConversationPresence {
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    private var activity: Activity<VoiceConversationActivityAttributes>?
    #endif

    func show() {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        guard activity == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        activity = try? Activity.request(
            attributes: VoiceConversationActivityAttributes(),
            content: ActivityContent(state: VoiceConversationActivityAttributes.ContentState(), staleDate: nil)
        )
        // One left by an app that was closed mid-conversation goes.
        Self.end(VoiceConversationLeftovers.toEnd(showing: Self.showing, keeping: activity?.id))
        #endif
    }

    func hide() {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        guard let activity else { return }
        self.activity = nil
        Self.end([activity.id])
        #endif
    }

    /// At launch no conversation runs, so an activity still showing was left
    /// by an app killed or crashed mid-conversation: it goes at once, rather
    /// than saying a conversation runs until iOS ends it hours later.
    static func endLeftovers() {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        end(VoiceConversationLeftovers.toEnd(showing: showing, keeping: nil))
        #endif
    }

    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    /// The ids of the voice conversation activities showing now.
    private static var showing: [String] {
        Activity<VoiceConversationActivityAttributes>.activities.map(\.id)
    }

    /// Ends the activities with these ids. They are looked up again off the
    /// main actor, by id, since an `Activity` cannot cross between actors.
    private static func end(_ ids: Set<String>) {
        guard !ids.isEmpty else { return }
        Task.detached {
            for activity in Activity<VoiceConversationActivityAttributes>.activities where ids.contains(activity.id) {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
    #endif
}

/// Which voice conversation activities go: every one showing but the
/// conversation's own. At launch none is kept.
enum VoiceConversationLeftovers {
    static func toEnd(showing: [String], keeping current: String?) -> Set<String> {
        Set(showing.filter { $0 != current })
    }
}
