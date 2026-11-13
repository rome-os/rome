import SwiftUI

/// "Task brief · From Chat": the brief the Concierge gave the task.
struct BriefCard: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left")
                    .romeFont(11)
                Text("Task brief · From Chat")
            }
            .romeFont(CardScale.label)
            .foregroundStyle(Palette.sub)
            MarkdownText(source: text, fontSize: CardScale.body, lineSpacing: 7)
        }
        .cardPadding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
    }
}

/// "Used 3 tools": collapsed by default, it opens to one row per call.
struct ToolSummary: View {
    let count: Int
    let calls: [ToolCall]?
    let onExpand: () -> Void
    @State private var expanded = false
    @State private var detail: ToolCall?

    var body: some View {
        Group {
            if expanded {
                VStack(spacing: 0) {
                    Button { toggle() } label: {
                        HStack(spacing: 6) {
                            WrenchGlyph()
                            Text("Used \(count) tools")
                            Spacer()
                            Image(systemName: "chevron.up").romeFont(10, .bold)
                        }
                        .romeFont(13, .medium)
                        .foregroundStyle(Palette.sub)
                        .padding(.horizontal, 14)
                        .frame(height: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if let calls {
                        if calls.isEmpty {
                            Text("No tool calls to show.")
                                .romeFont(13)
                                .foregroundStyle(Palette.sub)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .frame(height: 44)
                                .overlay(alignment: .top) { Rectangle().fill(Palette.hair).frame(height: 0.5) }
                        }
                        ForEach(calls) { call in
                            Button { detail = call } label: {
                                HStack(spacing: 10) {
                                    Text(call.name)
                                        .romeFont(12, .medium, design: .monospaced)
                                        .foregroundStyle(Palette.fg)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Palette.fill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                                    Text(call.detail)
                                        .romeFont(14)
                                        .foregroundStyle(Palette.sub)
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right")
                                        .romeFont(10, .bold)
                                        .foregroundStyle(Palette.sub)
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                            .overlay(alignment: .top) { Rectangle().fill(Palette.hair).frame(height: 0.5) }
                        }
                    } else {
                        Spinner(size: 16, color: Palette.sub)
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                            .overlay(alignment: .top) { Rectangle().fill(Palette.hair).frame(height: 0.5) }
                    }
                }
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
            } else {
                Button { toggle() } label: {
                    HStack(spacing: 6) {
                        WrenchGlyph()
                        Text("Used \(count) tools")
                        Image(systemName: "chevron.down").romeFont(9, .bold)
                    }
                    .romeFont(13, .medium)
                    .foregroundStyle(Palette.sub)
                    .padding(.leading, 10)
                    .padding(.trailing, 11)
                    .frame(height: 30)
                    .background(Palette.fill, in: Capsule())
                }
                .buttonStyle(PressScaleStyle())
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sheet(item: $detail) { call in
            ToolCallDetail(call: call)
                .presentationDetents([.medium, .large])
                .presentationBackground(Palette.sheet)
        }
    }

    private func toggle() {
        if !expanded { onExpand() }
        withAnimation(.spring(response: 0.35, dampingFraction: 0.88)) { expanded.toggle() }
    }
}

struct WrenchGlyph: View {
    var body: some View {
        Image(systemName: "wrench.adjustable")
            .romeFont(12, .semibold)
    }
}

/// A tool call's raw input.
struct ToolCallDetail: View {
    let call: ToolCall
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(call.name)
                    .romeFont(20, .bold, design: .monospaced)
                Spacer()
                SheetCloseButton { dismiss() }
            }
            if !call.detail.isEmpty {
                Text(call.detail).romeFont(15).foregroundStyle(Palette.sub)
            }
            ScrollView {
                Text(call.input.prettyText)
                    .romeFont(13, design: .monospaced)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(Palette.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .padding(20)
    }
}

/// The 30 pt round close button sheets use.
struct SheetCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .romeFont(11, .bold)
                .foregroundStyle(Palette.sub)
                .frame(width: 30, height: 30)
                .background(Palette.fillStrong, in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Close")
    }
}

/// An action paused for approval. Pending, it is the most visible thing on the
/// screen; once answered it folds into one line.
struct ApprovalCardView: View {
    let part: MessagePart.ApprovalPart
    /// Nil until the server's record arrives: stored cards always say pending.
    let status: ApprovalStatus?
    let submitting: Bool?
    let error: String?
    let resolvedAt: Date?
    /// A visitor sees the card but cannot answer it.
    var canResolve = true
    /// Drawn whole and read only, as a folded card opens: what it asked, no controls.
    var settled = false
    /// How it ended, in the line above a settled card's title.
    var settledLabel: String? = nil
    let onResolve: (Bool) -> Void

    private var title: String { part.title.flatMap { $0.isEmpty ? nil : $0 } ?? displayActionName(part.actionName) }

    var body: some View {
        Group {
            switch settled ? .pending : status {
            case _ where settled:
                settledCard
            case nil:
                HStack(spacing: 10) {
                    Spinner(size: 16, color: Palette.sub)
                    Text("Loading approval…").romeFont(15).foregroundStyle(Palette.sub)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
            case .pending:
                pendingCard
            case .approved, .executing, .executed:
                resolvedLine(success: true, label: status == .executed ? "Approved" : "Approved · Running")
            case .rejected:
                resolvedLine(success: false, label: "Rejected")
            case .failed:
                failedCard
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.86), value: status)
        .sensoryFeedback(trigger: status) { old, new in
            guard old == .pending else { return nil }
            return new == .rejected ? .impact(weight: .light) : .success
        }
    }

    /// An approval that no longer waits, opened read only: as an answered
    /// question card draws itself, the outcome, what it asked, then its
    /// details as a plain list.
    private var settledCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: settledLabel ?? String(localized: "Approval"))
                .romeFont(CardScale.label)
                .foregroundStyle(Palette.sub)
            Text(title)
                .romeFont(CardScale.title, .semibold)
                .foregroundStyle(Palette.sub)
                .lineSpacing(3)
            let rows: [(label: String?, value: String)] =
                ((part.summary ?? "").isEmpty ? [] : [(nil, part.summary ?? "")])
                + part.fields.map { (Optional($0.label), $0.value) }
            if !rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 { OptionDivider() }
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            if let label = row.label {
                                Text(label).romeFont(CardScale.caption).foregroundStyle(Palette.sub).frame(width: 44, alignment: .leading)
                            }
                            Text(row.value).romeFont(CardScale.body).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: CardScale.optionMinHeight, alignment: .leading)
                    }
                }
            }
        }
        .fillsBubbleWidth()
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
        .transition(.opacity)
    }

    private var pendingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "envelope")
                    .romeFont(CardScale.iconGlyph)
                    .foregroundStyle(Palette.sub)
                    .frame(width: CardScale.iconBox, height: CardScale.iconBox)
                    .background(Palette.fill, in: RoundedRectangle(cornerRadius: CardScale.iconCorner, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    (settled ? Text("Approval") : Text("Needs approval"))
                        .romeFont(CardScale.label)
                        .foregroundStyle(Palette.sub)
                    Text(title)
                        .romeFont(CardScale.title, .semibold)
                        .tracking(-0.3)
                }
            }
            if !part.fields.isEmpty || !(part.summary ?? "").isEmpty {
                VStack(spacing: 0) {
                    if let summary = part.summary, !summary.isEmpty {
                        Text(summary)
                            .romeFont(CardScale.body)
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, CardScale.fieldRowPadding)
                    }
                    ForEach(Array(part.fields.enumerated()), id: \.offset) { index, field in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(field.label)
                                .romeFont(CardScale.caption)
                                .foregroundStyle(Palette.sub)
                                .frame(width: 44, alignment: .leading)
                            Text(field.value)
                                .romeFont(CardScale.body)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, CardScale.fieldRowPadding)
                        .overlay(alignment: .top) {
                            if index > 0 || !(part.summary ?? "").isEmpty {
                                Rectangle().fill(Palette.hair).frame(height: 0.5)
                            }
                        }
                    }
                }
                .padding(.horizontal, CardScale.paddingH)
                .padding(.vertical, 2)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous))
            }
            if let error {
                HStack(spacing: 8) {
                    AlertGlyph(size: 15)
                    Text(error).romeFont(14, .medium)
                }
                .foregroundStyle(Palette.destructive)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.dangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if settled {
                EmptyView()
            } else if canResolve {
                // Sized to their words at the card's foot: Approve the one
                // accent button, Reject a quiet one beside it.
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    Button { onResolve(false) } label: {
                        Group {
                            if submitting == false {
                                Spinner(size: 16, lineWidth: 2.2, color: Palette.sub, trackOpacity: 0.2)
                            } else {
                                Text("Reject")
                            }
                        }
                        .romeFont(CardScale.actionFont, .medium)
                        .foregroundStyle(Palette.sub)
                        .padding(.horizontal, 14)
                        .frame(minWidth: 72, minHeight: CardScale.actionHeight)
                        .contentShape(Capsule())
                    }
                    .opacity(submitting == true ? 0.45 : 1)
                    Button { onResolve(true) } label: {
                        Group {
                            if submitting == true {
                                Spinner(size: 16, lineWidth: 2.2, color: .white, trackOpacity: 0.35)
                            } else {
                                Text("Approve")
                            }
                        }
                        .romeFont(CardScale.actionFont, .medium)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 88, minHeight: CardScale.actionHeight)
                        .background(Palette.primary, in: Capsule())
                    }
                    .opacity(submitting == false ? 0.45 : 1)
                }
                .buttonStyle(PressScaleStyle(scale: 0.97))
                .disabled(submitting != nil)
            } else {
                // Approvals are the owner's: the server answers a visitor 403.
                Text("Only the owner of this Rome can approve this")
                    .romeFont(14)
                    .foregroundStyle(Palette.sub)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .fillsBubbleWidth()
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
        .padding(.top, 4)
    }

    private func resolvedLine(success: Bool, label: LocalizedStringKey) -> some View {
        HStack(spacing: 10) {
            StatusGlyph(tone: success ? .done : .neutral)
                .overlay {
                    if !success {
                        ZStack {
                            Circle().fill(Palette.sub)
                            Image(systemName: "xmark").romeFont(8, .bold).foregroundStyle(.white)
                        }
                    }
                }
            (Text(label).fontWeight(.medium) + Text(verbatim: " · \(title)").foregroundStyle(Palette.sub))
                .romeFont(15)
            Spacer(minLength: 0)
            if let resolvedAt {
                Text(RelativeTime.clock(resolvedAt))
                    .romeFont(13, monospacedDigits: true)
                    .foregroundStyle(Palette.sub)
            }
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
    }

    private var failedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AlertGlyph(size: 15)
                Text("Approved, but “\(title)” didn't finish").romeFont(14, .medium)
            }
            .foregroundStyle(Palette.destructive)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.dangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .fillsBubbleWidth()
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
    }
}

/// The agent asked something: the card core described from its questions,
/// drawn as the dashboard draws it. A question stored before cards were
/// described shows its questions as a line.
struct QuestionCardView: View {
    let part: MessagePart.QuestionPart
    let answered: JSONValue?
    let sending: Bool
    /// The interaction's output: the card's answers, or `{ dismissed: true }`.
    let onAnswer: (JSONValue) -> Void

    var body: some View {
        if let card = part.ui {
            WidgetUICardView(part: card, call: { _, _, _ in throw APIError.notFound }, waiting: .init(
                answered: answered,
                sending: sending,
                answer: onAnswer,
                dismiss: { onAnswer(.object(["dismissed": .bool(true)])) }
            ))
        } else {
            Text(verbatim: part.questions.map(\.text).joined(separator: "\n"))
                .romeFont(CardScale.body)
                .foregroundStyle(Palette.sub)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A thin rule between the rows of a card's plain list.
struct OptionDivider: View {
    var body: some View {
        Rectangle().fill(Palette.hair).frame(height: 0.5).padding(.leading, 30)
    }
}

/// A part the phone does not draw: its name, and a button that opens its
/// chat on the dashboard, in the app.
struct WebOnlyCard: View {
    let kind: MessagePart.WebOnlyKind
    /// Answered already: it says so, instead of asking to be opened.
    var done = false
    /// The chat it is in, opened on the dashboard.
    var sessionId: String? = nil
    @Environment(AppModel.self) private var model
    @Environment(\.openInstancePage) private var openInstancePage

    private var title: String {
        guard case .app(let id) = kind else { return kind.title() }
        return kind.title(appName: model.workspace?.apps.first { $0.id == id }?.name)
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "globe")
                .romeFont(CardScale.iconGlyph)
                .foregroundStyle(Palette.fg)
                .frame(width: CardScale.iconBox, height: CardScale.iconBox)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: CardScale.iconCorner, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title)
                    .romeFont(CardScale.body)
                    .fixedSize(horizontal: false, vertical: true)
                Text(done ? "Done" : "Shown only on the web")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            }
            Spacer(minLength: 0)
            Button("Open") {
                if let origin = model.webURL {
                    openInstancePage(InstancePages.chat(origin: origin, sessionId: sessionId, mainChatServerID: model.workspace?.mainChatServerID))
                }
            }
            .romeFont(CardScale.actionFont, .medium)
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 13)
            .frame(height: CardScale.actionHeight)
            .background(Palette.fill, in: Capsule())
            .buttonStyle(PressScaleStyle())
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
    }
}
