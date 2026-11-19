import SwiftUI

/// Above the composer while it replies to a message: a line of that
/// message, and a cross that drops the reply.
struct QuoteBar: View {
    /// The quoted message; nil while it is not held.
    let message: ChatMessage?
    let onCancel: () -> Void

    private var preview: String {
        let text = message?.parts.compactMap { part -> String? in
            if case .text(let text, _, _) = part { return text }
            return nil
        }.joined(separator: " ") ?? ""
        return MarkdownParser.plain(text).split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrowshape.turn.up.left")
                .romeFont(12)
                .foregroundStyle(Palette.sub)
            Text(verbatim: preview.isEmpty ? String(localized: "Reply") : preview)
                .romeFont(13)
                .foregroundStyle(Palette.sub)
                .lineLimit(1)
            Spacer(minLength: 4)
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .romeFont(11, .semibold)
                    .foregroundStyle(Palette.sub)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(Text("Cancel reply"))
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(minHeight: 34)
        .glassSurface(Capsule(), frost: Frost.composer)
        .accessibilityElement(children: .contain)
    }
}

/// The quote a reply carries when it does not sit under what it answers
/// (docs/domains/chats.md#chat-thread): a small reply arrow and one muted line
/// of the original, at the top of its bubble. A tap goes to the original.
/// `quotedAbove(_:tone:onTap:)` puts it in a bubble's content.
struct QuotedReply: View {
    /// The bubble the quote sits in: the guardian's, which is the primary color, or the Concierge's.
    enum Tone { case sent, received }

    let quote: MessagePart.ReplyQuote
    var tone: Tone = .sent
    let onTap: (() -> Void)?

    /// On the guardian's bubble the quote is white at about 82%, as on the web.
    private var ink: Color { tone == .sent ? Color.white.opacity(0.82) : Palette.sub }

    /// An automation's message names it first.
    private var line: String {
        quote.author == "automated" ? "\(quote.name ?? String(localized: "Automation")) · \(quote.line)" : quote.line
    }

    var body: some View {
        let content = HStack(spacing: 4) {
            Image(systemName: "arrowshape.turn.up.left").romeFont(11).opacity(0.8)
            Text(verbatim: line).romeFont(12).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .foregroundStyle(ink)
        if let onTap {
            Button(action: onTap) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityHint(Text("Shows the message it replies to"))
                .accessibilityIdentifier("reply-quote")
        } else {
            content
        }
    }
}

/// A bubble's content with the quote of its reply on top. The quote is drawn
/// over a space the content leaves for it, so it fills the content's width and
/// never widens the bubble: a long original is cut. A bubble with a quote is at
/// least 14 rem wide, so a short reply still shows some of it.
private struct QuotedAbove: ViewModifier {
    let quote: MessagePart.ReplyQuote?
    let tone: QuotedReply.Tone
    let onTap: (() -> Void)?
    /// Whether the content has text under the quote: a quote alone takes no gap.
    let hasContent: Bool
    @ScaledMetric(relativeTo: .caption) private var line = 16.0

    /// 14 rem, less the bubble's 14 pt of padding on each side.
    static let minWidth: CGFloat = 14 * 16 - 2 * 14

    func body(content: Content) -> some View {
        if let quote {
            content
                .padding(.top, line + (hasContent ? 4 : 0))
                .frame(minWidth: Self.minWidth, alignment: .leading)
                .overlay(alignment: .topLeading) {
                    QuotedReply(quote: quote, tone: tone, onTap: onTap)
                        .frame(height: line)
                }
        } else {
            content
        }
    }
}

extension View {
    /// The quote a reply carries, at the top of this bubble content.
    func quotedAbove(_ quote: MessagePart.ReplyQuote?, tone: QuotedReply.Tone, hasContent: Bool = true, onTap: (() -> Void)?) -> some View {
        modifier(QuotedAbove(quote: quote, tone: tone, onTap: onTap, hasContent: hasContent))
    }
}

extension TranscriptRow {
    /// The stored message a row draws, a card's included: part rows are
    /// `<message id>:<part index>`. A label is under its message, not of it,
    /// so a tint leaves it out.
    var ownMessageId: String? {
        switch self {
        case .separator, .typing, .tools, .sourceLabel, .unreadDivider: return nil
        default: return messageId ?? Self.message(ofPart: id)
        }
    }
}

extension EnvironmentValues {
    /// Set on a row whose message is tinted. The bubble or card reads it, so
    /// the tint hugs its shape and never fills the row's width.
    @Entry var rowTinted = false
}

extension View {
    /// The tint of a message a quote led to.
    func tinted(_ on: Bool) -> some View {
        background {
            if on {
                RoundedRectangle(cornerRadius: Metrics.bubbleRadius + 4, style: .continuous)
                    .fill(Palette.primarySoft)
                    .padding(.horizontal, -6)
                    .padding(.vertical, -3)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.3), value: on)
    }
}
