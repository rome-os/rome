import SwiftUI

/// "任务说明 · 来自 Chat": the brief the Concierge gave the task.
struct BriefCard: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left")
                    .romeFont(11, .semibold)
                Text("任务说明 · 来自 Chat")
            }
            .romeFont(12, .semibold)
            .foregroundStyle(Palette.sub)
            MarkdownText(source: text, fontSize: 15, lineSpacing: 7)
        }
        .padding(.horizontal, 15)
        .padding(.top, 13)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
    }
}

/// "用了 3 个工具": collapsed by default, it opens to one row per call.
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
                            Text("用了 \(count) 个工具")
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
                            Text("没有可显示的工具记录。")
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
                        Text("用了 \(count) 个工具")
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
        .accessibilityLabel("关闭")
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
    let onResolve: (Bool) -> Void

    private var title: String { part.title.flatMap { $0.isEmpty ? nil : $0 } ?? displayActionName(part.actionName) }

    var body: some View {
        Group {
            switch status {
            case nil:
                HStack(spacing: 10) {
                    Spinner(size: 16, color: Palette.sub)
                    Text("正在读取审批…").romeFont(15).foregroundStyle(Palette.sub)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
                .hairline(radius: Metrics.groupRadius)
            case .pending:
                pendingCard
            case .approved, .executing, .executed:
                resolvedLine(success: true, label: status == .executed ? "已批准" : "已批准 · 正在执行")
            case .rejected:
                resolvedLine(success: false, label: "已拒绝")
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
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "envelope")
                    .romeFont(17, .medium)
                    .foregroundStyle(Palette.warningText)
                    .frame(width: 36, height: 36)
                    .background(Palette.warnSoft, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("需要批准")
                        .romeFont(12, .semibold)
                        .foregroundStyle(Palette.warningText)
                    Text(title)
                        .romeFont(17, .semibold)
                        .tracking(-0.4)
                }
            }
            if !part.fields.isEmpty || !(part.summary ?? "").isEmpty {
                VStack(spacing: 0) {
                    if let summary = part.summary, !summary.isEmpty {
                        Text(summary)
                            .romeFont(15)
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 10)
                    }
                    ForEach(Array(part.fields.enumerated()), id: \.offset) { index, field in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(field.label)
                                .romeFont(13)
                                .foregroundStyle(Palette.sub)
                                .frame(width: 44, alignment: .leading)
                            Text(field.value)
                                .romeFont(15, .medium)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 10)
                        .overlay(alignment: .top) {
                            if index > 0 || !(part.summary ?? "").isEmpty {
                                Rectangle().fill(Palette.hair).frame(height: 0.5)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 2)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
            HStack(spacing: 10) {
                Button { onResolve(false) } label: {
                    Group {
                        if submitting == false {
                            Spinner(size: 18, lineWidth: 2.4, color: Palette.fg, trackOpacity: 0.2)
                        } else {
                            Text("拒绝")
                        }
                    }
                    .romeFont(17, .semibold)
                    .foregroundStyle(Palette.fg)
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
                    .background(Palette.fill, in: Capsule())
                }
                .opacity(submitting == true ? 0.45 : 1)
                Button { onResolve(true) } label: {
                    Group {
                        if submitting == true {
                            Spinner(size: 18, lineWidth: 2.4, color: .white, trackOpacity: 0.35)
                        } else {
                            Text("批准")
                        }
                    }
                    .romeFont(17, .semibold)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 46)
                    .background(Palette.primary, in: Capsule())
                    .shadow(color: Palette.primary.opacity(0.5), radius: 7, x: 0, y: 6)
                }
                .opacity(submitting == false ? 0.45 : 1)
            }
            .buttonStyle(PressScaleStyle(scale: 0.97))
            .disabled(submitting != nil)
        }
        .padding(16)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous).strokeBorder(Palette.warnRing, lineWidth: 1))
        .shadow(color: Palette.cardShadow, radius: 16, x: 0, y: 12)
        .padding(.top, 4)
    }

    private func resolvedLine(success: Bool, label: String) -> some View {
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
            (Text(label).fontWeight(.semibold) + Text(" · \(title)").foregroundStyle(Palette.sub))
                .romeFont(15)
            Spacer(minLength: 0)
            if let resolvedAt {
                Text(RelativeTime.clock(resolvedAt))
                    .romeFont(13, monospacedDigits: true)
                    .foregroundStyle(Palette.sub)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.groupRadius, style: .continuous))
        .hairline(radius: Metrics.groupRadius)
        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
    }

    private var failedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AlertGlyph(size: 15)
                Text("已批准，但\(title)没有完成。").romeFont(14, .medium)
            }
            .foregroundStyle(Palette.destructive)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.dangerSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(16)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
    }
}

/// The agent asked something. Options answer in one tap; "其他回答…" takes text.
struct QuestionCardView: View {
    let part: MessagePart.QuestionPart
    let answered: JSONValue?
    let sending: Bool
    let onAnswer: ([String: String]) -> Void

    @State private var choices: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @FocusState private var focusedQuestion: String?

    private var answers: [String: String] {
        var result: [String: String] = [:]
        for item in answered?["answers"]?.array ?? [] {
            if let id = item["questionId"]?.string, let value = item["value"]?.string { result[id] = value }
        }
        return result
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
            Text("在等你回答")
                .romeFont(12, .semibold)
                .foregroundStyle(Palette.warningText)
            ForEach(part.questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.text)
                        .romeFont(17, .semibold)
                        .tracking(-0.4)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 8) {
                        ForEach(question.options, id: \.self) { option in
                            optionButton(question, option)
                        }
                        HStack(spacing: 8) {
                            TextField(question.options.isEmpty ? "写下回答…" : "其他回答…", text: binding(question.id), axis: .vertical)
                                .romeFont(16)
                                .lineLimit(1...4)
                                .focused($focusedQuestion, equals: question.id)
                                .padding(.vertical, 12)
                            if !(typed[question.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
                                Button {
                                    submit(override: [question.id: typed[question.id] ?? ""])
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
                        .frame(minHeight: 46)
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hair, lineWidth: 1))
                        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: typed[question.id]?.isEmpty ?? true)
                    }
                }
            }
            if !single {
                PrimaryButton(title: "提交", loading: sending, disabled: !complete) { submit(override: [:]) }
            }
        }
        .padding(16)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous).strokeBorder(Palette.warnRing, lineWidth: 1))
        .shadow(color: Palette.cardShadow, radius: 16, x: 0, y: 12)
        .padding(.top, 4)
        .disabled(sending)
        .opacity(sending ? 0.7 : 1)
    }

    private func optionButton(_ question: MessagePart.QuestionPart.Question, _ option: String) -> some View {
        let selected = choices[question.id]?.contains(option) ?? false
        return Button {
            if question.multi {
                var set = choices[question.id] ?? []
                if set.contains(option) { set.remove(option) } else { set.insert(option) }
                choices[question.id] = set
            } else {
                choices[question.id] = [option]
                if single { submit(override: [question.id: option]) }
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
                Text(option)
                    .romeFont(16, .medium)
                    .foregroundStyle(Palette.fg)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 46)
            .background(selected ? Palette.primarySoft : Palette.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                if selected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.primary, lineWidth: 1.5)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .sensoryFeedback(.selection, trigger: selected)
    }

    private var complete: Bool {
        part.questions.allSatisfy { question in
            !(choices[question.id]?.isEmpty ?? true) || !(typed[question.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { typed[id] ?? "" }, set: { typed[id] = $0 })
    }

    private func submit(override: [String: String]) {
        var values: [String: String] = [:]
        for question in part.questions {
            let picked = (choices[question.id] ?? []).sorted()
            let text = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            values[question.id] = override[question.id] ?? (picked + (text.isEmpty ? [] : [text])).joined(separator: ", ")
        }
        focusedQuestion = nil
        onAnswer(values)
    }

    private var answeredCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("已回答")
                .romeFont(12, .semibold)
                .foregroundStyle(Palette.sub)
            ForEach(part.questions, id: \.id) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.text)
                        .romeFont(16, .semibold)
                        .foregroundStyle(Palette.sub)
                        .lineSpacing(3)
                    let answer = answers[question.id] ?? ""
                    let picked = Set(answer.components(separatedBy: ", "))
                    ForEach(question.options, id: \.self) { option in
                        if picked.contains(option) {
                            HStack(spacing: 12) {
                                ZStack {
                                    Circle().fill(Palette.primary)
                                    Image(systemName: "checkmark").romeFont(9, .heavy).foregroundStyle(.white)
                                }
                                .frame(width: 18, height: 18)
                                Text(option).romeFont(16, .semibold)
                            }
                            .padding(.horizontal, 14)
                            .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                            .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.primary, lineWidth: 1.5))
                        } else {
                            Text(option)
                                .romeFont(16)
                                .foregroundStyle(Palette.sub)
                                .padding(.leading, 44)
                                .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                        }
                    }
                    let extra = picked.subtracting(question.options).filter { !$0.isEmpty }
                    if !extra.isEmpty {
                        Text(extra.sorted().joined(separator: ", "))
                            .romeFont(16, .semibold)
                            .padding(.horizontal, 14)
                            .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                            .background(Palette.primarySoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.primary, lineWidth: 1.5))
                    }
                }
            }
        }
        .padding(16)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.bigCardRadius, style: .continuous))
        .hairline(radius: Metrics.bigCardRadius)
        .transition(.opacity)
    }
}

/// Parts the phone does not draw: open them on the Web.
struct WebOnlyCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "safari")
                .romeFont(17)
                .foregroundStyle(Palette.fg)
                .frame(width: 32, height: 32)
                .background(Palette.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text("这部分内容需要在 Web 上查看")
                .romeFont(15)
            Spacer(minLength: 0)
            Button("打开") {
                if let url = model.webURL { openURL(url) }
            }
            .romeFont(14, .semibold)
            .foregroundStyle(Palette.fg)
            .padding(.horizontal, 13)
            .frame(height: 32)
            .background(Palette.fill, in: Capsule())
            .buttonStyle(PressScaleStyle())
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .padding(.vertical, 12)
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
