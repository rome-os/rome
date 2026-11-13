import SwiftUI

/// The words of a Concierge chat's faint lines.
enum NoticeCopy {
    /// "Routine · Daily summary", or the kind alone when the source has no name.
    static func automated(_ source: TraceSummary.InputSource) -> String {
        let kind: String
        switch source.type {
        case "routine": kind = String(localized: "Routine")
        case "app": kind = String(localized: "App")
        case "agent": kind = String(localized: "Agent")
        default: kind = String(localized: "Automation")
        }
        guard let name = source.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return kind }
        return "\(kind) · \(name)"
    }

    /// "Context tidied up · conversation got long". A reason this build does
    /// not know shows as it came.
    static func renewal(_ reason: String) -> String {
        let why: String
        switch reason {
        case "context": why = String(localized: "conversation got long")
        case "setup": why = String(localized: "setup updated")
        case "idle": why = String(localized: "after a quiet period")
        case "daily": why = String(localized: "daily reset")
        case "working_dir": why = String(localized: "working folder gone")
        default: why = reason
        }
        return String(localized: "Context tidied up · \(why)")
    }
}

/// A faint centered line where a routine, an app or another agent sent
/// something into a Concierge chat: only who sent it. What it sent is the
/// Concierge's input and stays in the turn's trace. Not tappable.
struct AutomatedInputLine: View {
    let source: TraceSummary.InputSource

    var body: some View {
        Text(verbatim: NoticeCopy.automated(source))
            .romeFont(12)
            .foregroundStyle(Palette.sub.opacity(0.75))
            .lineLimit(1)
            .frame(maxWidth: .infinity)
    }
}

/// A faint centered line where the chat's agent session was renewed, with
/// why. When the renewal wrote a handoff for the new session, a tap opens it
/// in a sheet; without one the line stays plain.
struct SessionRenewalLine: View {
    let reason: String
    let sessionId: String?
    let store: TranscriptStore

    @State private var showsHandoff = false

    private var handoff: String? { sessionId.flatMap { store.handoffs[$0] ?? nil } }

    var body: some View {
        Group {
            if let handoff {
                Button { showsHandoff = true } label: {
                    HStack(spacing: 3) {
                        Text(verbatim: NoticeCopy.renewal(reason))
                        Image(systemName: "chevron.right").romeFont(9, .semibold)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, -8)
                .accessibilityHint(Text("Shows the summary carried over"))
                .sheet(isPresented: $showsHandoff) { HandoffSheet(text: handoff) }
            } else {
                Text(verbatim: NoticeCopy.renewal(reason))
            }
        }
        .romeFont(12)
        .foregroundStyle(Palette.sub.opacity(0.75))
        .lineLimit(1)
        .frame(maxWidth: .infinity)
        .task(id: sessionId) {
            if let sessionId { await store.loadHandoff(sessionId) }
        }
    }
}

/// The summary a retired session wrote for the next one.
struct HandoffSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Summary carried over")
                    .romeFont(17, .semibold)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            ScrollView {
                MarkdownText(source: text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // The sheet is presented from the faint line, whose one line and quiet
        // color it would inherit through the environment.
        .lineLimit(nil)
        .foregroundStyle(Palette.fg)
        .padding(20)
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.sheet)
    }
}
