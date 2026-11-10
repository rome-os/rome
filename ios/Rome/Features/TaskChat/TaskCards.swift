import SwiftUI

/// "Task brief · From Chat": the brief the Concierge gave the task.
struct BriefCard: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left")
                    .romeFont(11, .semibold)
                Text("Task brief · From Chat")
            }
            .romeFont(CardScale.label, .semibold)
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
                                        .romeFont(12, .semibold, design: .monospaced)
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
    let onResolve: (Bool) -> Void

    private var title: String { part.title.flatMap { $0.isEmpty ? nil : $0 } ?? displayActionName(part.actionName) }

    var body: some View {
        Group {
            switch status {
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

    private var pendingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "envelope")
                    .romeFont(CardScale.iconGlyph, .medium)
                    .foregroundStyle(Palette.warningText)
                    .frame(width: CardScale.iconBox, height: CardScale.iconBox)
                    .background(Palette.warnSoft, in: RoundedRectangle(cornerRadius: CardScale.iconCorner, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Needs approval")
                        .romeFont(CardScale.label, .semibold)
                        .foregroundStyle(Palette.warningText)
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
                                .romeFont(CardScale.body, .medium)
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
            if canResolve {
                HStack(spacing: 10) {
                    Button { onResolve(false) } label: {
                        Group {
                            if submitting == false {
                                Spinner(size: 18, lineWidth: 2.4, color: Palette.fg, trackOpacity: 0.2)
                            } else {
                                Text("Reject")
                            }
                        }
                        .romeFont(CardScale.buttonFont, .semibold)
                        .foregroundStyle(Palette.fg)
                        .frame(maxWidth: .infinity)
                        .frame(height: CardScale.buttonHeight)
                        .background(Palette.fill, in: Capsule())
                    }
                    .opacity(submitting == true ? 0.45 : 1)
                    Button { onResolve(true) } label: {
                        Group {
                            if submitting == true {
                                Spinner(size: 18, lineWidth: 2.4, color: .white, trackOpacity: 0.35)
                            } else {
                                Text("Approve")
                            }
                        }
                        .romeFont(CardScale.buttonFont, .semibold)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: CardScale.buttonHeight)
                        .background(Palette.primary, in: Capsule())
                        .shadow(color: Palette.primary.opacity(0.5), radius: 7, x: 0, y: 6)
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
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous).strokeBorder(Palette.warnRing, lineWidth: 1))
        .shadow(color: Palette.cardShadow, radius: 16, x: 0, y: 12)
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
            (Text(label).fontWeight(.semibold) + Text(verbatim: " · \(title)").foregroundStyle(Palette.sub))
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
                Text("Approved, but “\(title)” did not finish").romeFont(14, .medium)
            }
            .foregroundStyle(Palette.destructive)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.dangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
    }
}

/// The agent asked something. Options answer in one tap; "Or type your own…" takes text.
struct QuestionCardView: View {
    let part: MessagePart.QuestionPart
    let answered: JSONValue?
    let sending: Bool
    /// The `answers` to send, shaped as the web's QuestionCard sends them.
    let onAnswer: ([JSONValue]) -> Void

    /// Chosen options per question, in the order they were picked.
    @State private var choices: [String: [String]]
    @State private var typed: [String: String]
    @FocusState private var focusedQuestion: String?

    init(part: MessagePart.QuestionPart, answered: JSONValue?, sending: Bool, onAnswer: @escaping ([JSONValue]) -> Void) {
        self.part = part
        self.answered = answered
        self.sending = sending
        self.onAnswer = onAnswer
        // Defaults are chosen before the guardian touches anything, and stay editable.
        let initial = QuestionAnswers.initial(part.questions)
        _choices = State(initialValue: initial.choices)
        _typed = State(initialValue: initial.typed)
    }

    private func answer(for question: MessagePart.QuestionPart.Question) -> JSONValue? {
        (answered?["answers"]?.array ?? []).first { $0["questionId"]?.string == question.id }
    }

    var body: some View {
        if answered != nil {
            answeredCard
        } else {
            pendingCard
        }
    }

    private var single: Bool { part.questions.count == 1 && !(part.questions.first?.multi ?? true) }

    private var pendingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Waiting for your answer")
                .romeFont(CardScale.label, .semibold)
                .foregroundStyle(Palette.warningText)
            ForEach(part.questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.text)
                        .romeFont(CardScale.title, .semibold)
                        .tracking(-0.4)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 8) {
                        ForEach(question.options, id: \.self) { option in
                            optionButton(question, option)
                        }
                        HStack(spacing: 8) {
                            TextField(question.options.isEmpty ? "Type your answer…" : "Or type your own…", text: binding(question.id), axis: .vertical)
                                .romeFont(CardScale.body)
                                .lineLimit(1...4)
                                .focused($focusedQuestion, equals: question.id)
                                .padding(.vertical, 12)
                            if single, let answers = QuestionAnswers.inlineSend(question, choices: choices, typed: typed) {
                                Button {
                                    focusedQuestion = nil
                                    onAnswer(answers)
                                } label: {
                                    Image(systemName: "arrow.up")
                                        .romeFont(14, .bold)
                                        .foregroundStyle(.white)
                                        .frame(width: 30, height: 30)
                                        .background(Palette.primary, in: Circle())
                                }
                                .buttonStyle(PressScaleStyle(scale: 0.9))
                                .transition(.scale.combined(with: .opacity))
                            }
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: CardScale.optionMinHeight)
                        .overlay(RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous).strokeBorder(Palette.hair, lineWidth: 1))
                        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: typed[question.id]?.isEmpty ?? true)
                    }
                }
            }
            if !single {
                PrimaryButton(title: "Submit", loading: sending, disabled: !complete, inCard: true) { submit() }
            }
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous).strokeBorder(Palette.warnRing, lineWidth: 1))
        .shadow(color: Palette.cardShadow, radius: 16, x: 0, y: 12)
        .padding(.top, 4)
        .disabled(sending)
        .opacity(sending ? 0.7 : 1)
    }

    private func optionButton(_ question: MessagePart.QuestionPart.Question, _ option: String) -> some View {
        let selected = choices[question.id]?.contains(option) ?? false
        let description = question.optionDescriptions[option]
        return Button {
            if question.multi {
                var list = choices[question.id] ?? []
                if let index = list.firstIndex(of: option) { list.remove(at: index) } else { list.append(option) }
                choices[question.id] = list
            } else {
                choices[question.id] = [option]
                // Choosing replaces what was typed: the choice is the answer.
                typed[question.id] = nil
                if single { submit(choices: [question.id: [option]], typed: [:]) }
            }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    if selected {
                        Circle().fill(Palette.primary)
                        Image(systemName: "checkmark").romeFont(9, .heavy).foregroundStyle(.white)
                    } else {
                        Circle().strokeBorder(Palette.sub, lineWidth: 1.5)
                    }
                }
                .frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option)
                        .romeFont(CardScale.body, .medium)
                        .foregroundStyle(Palette.fg)
                        .multilineTextAlignment(.leading)
                    if let description {
                        // Shown only: an answer carries the label.
                        Text(description)
                            .romeFont(CardScale.caption)
                            .foregroundStyle(Palette.sub)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, description == nil ? 0 : CardScale.fieldRowPadding)
            .frame(minHeight: CardScale.optionMinHeight)
            .background(selected ? Palette.primarySoft : Palette.fill, in: RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous))
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous).strokeBorder(Palette.primary, lineWidth: 1.5)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .sensoryFeedback(.selection, trigger: selected)
    }

    /// Optional questions never block Submit; a required one with a default is answered.
    private var complete: Bool {
        QuestionAnswers.complete(part.questions, choices: choices, typed: typed)
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { typed[id] ?? "" }, set: { typed[id] = $0 })
    }

    private func submit(choices: [String: [String]]? = nil, typed: [String: String]? = nil) {
        let choices = choices ?? self.choices, typed = typed ?? self.typed
        // Every required question answered; a card of only optional ones may go blank.
        guard QuestionAnswers.complete(part.questions, choices: choices, typed: typed) else { return }
        let answers = QuestionAnswers.answers(part.questions, choices: choices, typed: typed)
        focusedQuestion = nil
        onAnswer(answers)
    }

    private var answeredCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Answered")
                .romeFont(CardScale.label, .semibold)
                .foregroundStyle(Palette.sub)
            ForEach(part.questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.text)
                        .romeFont(CardScale.title, .semibold)
                        .foregroundStyle(Palette.sub)
                        .lineSpacing(3)
                    let stored = QuestionAnswers.picked(answer(for: question), question: question)
                    let picked = stored.options
                    ForEach(question.options, id: \.self) { option in
                        if picked.contains(option) {
                            HStack(spacing: 12) {
                                ZStack {
                                    Circle().fill(Palette.primary)
                                    Image(systemName: "checkmark").romeFont(9, .heavy).foregroundStyle(.white)
                                }
                                .frame(width: 18, height: 18)
                                Text(option).romeFont(CardScale.body, .semibold)
                            }
                            .padding(.horizontal, 14)
                            .frame(maxWidth: .infinity, minHeight: CardScale.optionMinHeight, alignment: .leading)
                            .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous).strokeBorder(Palette.primary, lineWidth: 1.5))
                        } else {
                            Text(option)
                                .romeFont(CardScale.body)
                                .foregroundStyle(Palette.sub)
                                .padding(.leading, 44)
                                .frame(maxWidth: .infinity, minHeight: CardScale.optionMinHeight, alignment: .leading)
                        }
                    }
                    let extra = stored.extra
                    if !extra.isEmpty {
                        Text(extra.joined(separator: QuestionAnswers.separator))
                            .romeFont(CardScale.body, .semibold)
                            .padding(.horizontal, 14)
                            .frame(maxWidth: .infinity, minHeight: CardScale.optionMinHeight, alignment: .leading)
                            .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: CardScale.fieldCorner, style: .continuous).strokeBorder(Palette.primary, lineWidth: 1.5))
                    }
                }
            }
        }
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
        .transition(.opacity)
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
            .romeFont(CardScale.actionFont, .semibold)
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

struct ErrorLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            AlertGlyph(size: 16).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            Text(text)
                .romeFont(15)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(2)
        .accessibilityElement(children: .combine)
    }
}
