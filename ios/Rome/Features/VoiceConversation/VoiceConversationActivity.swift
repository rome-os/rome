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
        // One left by an app that was closed mid-conversation goes.
        let leftovers = Activity<VoiceConversationActivityAttributes>.activities
        activity = try? Activity.request(
            attributes: VoiceConversationActivityAttributes(),
            content: ActivityContent(state: VoiceConversationActivityAttributes.ContentState(), staleDate: nil)
        )
        Task {
            for leftover in leftovers { await leftover.end(nil, dismissalPolicy: .immediate) }
        }
        #endif
    }

    func hide() {
        #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
        #endif
    }
}
