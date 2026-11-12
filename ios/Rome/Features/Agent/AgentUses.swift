import Foundation

/// One row of the Agent page's Uses tab: a symbol and a short title. A tap
/// puts the full prompt in the chat's composer, unsent; the page never shows
/// it. Edit the list here; each string needs its Simplified Chinese in
/// `Localizable.xcstrings`.
struct AgentUse: Identifiable {
    /// An SF Symbol, drawn in line style.
    let symbol: String
    let title: String
    let prompt: String

    var id: String { symbol }

    static var all: [AgentUse] {
        [
            AgentUse(symbol: "sun.max", title: String(localized: "Daily brief"), prompt: String(localized: "Every weekday at 8am, send me a brief of today's calendar and important emails.")),
            AgentUse(symbol: "bell", title: String(localized: "Watch a price"), prompt: String(localized: "Tell me when the price of ___ drops below $___.")),
            AgentUse(symbol: "envelope", title: String(localized: "Urgent emails only"), prompt: String(localized: "Check my inbox every hour and only ping me for urgent emails.")),
            AgentUse(symbol: "square.grid.2x2", title: String(localized: "Make an app"), prompt: String(localized: "Make an app to track my workouts, with a weekly chart.")),
            AgentUse(symbol: "heart", title: String(localized: "How I slept"), prompt: String(localized: "How did I sleep last night?")),
            AgentUse(symbol: "magnifyingglass", title: String(localized: "Research"), prompt: String(localized: "Compare the best noise-cancelling headphones under $300.")),
        ]
    }
}
