import Foundation

/// Display names for the concrete model ids the instance records, the table
/// of the dashboard's `lib/model-display.ts`. An id missing here shows as it
/// is, so a new model still reads truthfully until it gets a row.
enum ModelNames {
    private static let names: [String: String] = [
        "claude-opus-5-5[1m]": "Opus 5.5",
        "claude-opus-5-5": "Opus 5.5",
        "claude-opus-5[1m]": "Opus 5",
        "claude-opus-5": "Opus 5",
        "claude-opus-4-8[1m]": "Opus 4.8",
        "claude-opus-4-8": "Opus 4.8",
        "claude-opus-4-6[1m]": "Opus 4.6",
        "claude-opus-4-6": "Opus 4.6",
        "claude-sonnet-5-5": "Sonnet 5.5",
        "claude-sonnet-5": "Sonnet 5",
        "claude-sonnet-4-6": "Sonnet 4.6",
        "claude-sonnet-4-5": "Sonnet 4.5",
        "claude-haiku-5-5": "Haiku 5.5",
        "claude-haiku-4-5": "Haiku 4.5",
        "claude-fable-5-1[1m]": "Fable 5.1",
        "claude-fable-5-1": "Fable 5.1",
        "claude-fable-5[1m]": "Fable 5",
        "gpt-6-astra": "GPT-6 Astra",
        "gpt-6.1-sol": "GPT-6.1 Sol",
        "gpt-6-sol": "GPT-6 Sol",
        "gpt-6-luna": "GPT-6 Luna",
        "gpt-5.6-sol": "GPT-5.6 Sol",
        "gpt-5.6-terra": "GPT-5.6 Terra",
        "gpt-5.6-luna": "GPT-5.6 Luna",
        "gpt-5.5": "GPT-5.5",
        "gpt-5.4": "GPT-5.4",
        "gpt-5.4-mini": "GPT-5.4 Mini",
        "gpt-5.3-codex": "GPT-5.3 Codex",
    ]

    /// `claude-opus-5-5[1m]` is `Opus 5.5`; an unknown id comes back unchanged.
    static func display(_ model: String) -> String { names[model] ?? model }
}
