import SwiftUI

/// Something to ask the Concierge, offered by the lightbulb beside the composer.
struct Suggestion: Identifiable, Hashable, Sendable {
    let id: String
    let systemImage: String
    /// Sent as the guardian's message, in the app's language.
    let text: String

    static var all: [Suggestion] {
        [
            Suggestion(id: "trip", systemImage: "point.topleft.down.to.point.bottomright.curvepath", text: String(localized: "Plan my weekend trip and check the weather")),
            Suggestion(id: "gmail", systemImage: "envelope", text: String(localized: "Watch my Gmail inbox for me")),
            Suggestion(id: "watch", systemImage: "dot.radiowaves.left.and.right", text: String(localized: "What can you watch for me?")),
        ]
    }
}

/// Whether the suggestions are open, and what a pick does: it sends exactly
/// that text and closes the bubble.
@MainActor
@Observable
final class SuggestionsState {
    var isOpen = false
    /// The screen's own send: a blank topic chat starts its chat first.
    @ObservationIgnored var send: @MainActor (String) -> Void = { _ in }

    func toggle() { isOpen.toggle() }
    func close() { isOpen = false }

    func pick(_ suggestion: Suggestion) {
        isOpen = false
        send(suggestion.text)
    }
}

/// The lightbulb's frame, for the bubble to point at.
struct SuggestionAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

/// The small round button to the right of the message field.
struct SuggestionButton: View {
    let isOpen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "lightbulb")
                .romeFont(15, .medium)
                .foregroundStyle(isOpen ? Palette.warning : Palette.sub)
                .frame(width: 34, height: 34)
                .background(isOpen ? Palette.warnSoft : Color.clear, in: Circle())
                .overlay(Circle().strokeBorder(isOpen ? Palette.warnRing : Palette.hair, lineWidth: 0.5))
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.88))
        .anchorPreference(key: SuggestionAnchorKey.self, value: .bounds) { $0 }
        .animation(.easeOut(duration: 0.18), value: isOpen)
        .accessibilityLabel("Suggestions")
        .accessibilityAddTraits(isOpen ? .isSelected : [])
    }
}

/// The composer with the lightbulb beside it.
struct SuggestingComposer<Field: View>: View {
    let state: SuggestionsState
    var focus: FocusState<Bool>.Binding
    @ViewBuilder let field: () -> Field

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            field()
            SuggestionButton(isOpen: state.isOpen) {
                // The bubble sits where the keyboard would be.
                focus.wrappedValue = false
                withAnimation(Self.spring) { state.toggle() }
            }
            .padding(.bottom, 8)
        }
    }

    static var spring: Animation { .spring(response: 0.34, dampingFraction: 0.72) }
}

extension View {
    /// Dims the screen and shows the suggestions above the lightbulb while
    /// `state` is open. Tapping outside closes them.
    func suggestionsOverlay(_ state: SuggestionsState) -> some View {
        overlayPreferenceValue(SuggestionAnchorKey.self) { anchor in
            GeometryReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    if state.isOpen {
                        Color.black.opacity(0.14)
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture { withAnimation(SuggestingComposer<EmptyView>.spring) { state.close() } }
                            .transition(.opacity)
                            .accessibilityHidden(true)
                    }
                    if state.isOpen, let anchor {
                        let button = proxy[anchor]
                        SuggestionBubble(tailFromTrailing: button.width / 2, onPick: { suggestion in
                            withAnimation(SuggestingComposer<EmptyView>.spring) { state.pick(suggestion) }
                        })
                        .frame(maxWidth: min(320, proxy.size.width - 32), alignment: .trailing)
                        .padding(.trailing, max(0, proxy.size.width - button.maxX))
                        .padding(.bottom, max(0, proxy.size.height - button.minY + 6))
                        .transition(.scale(scale: 0.6, anchor: .bottomTrailing).combined(with: .opacity))
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .bottomTrailing)
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: state.isOpen) { _, open in open }
    }
}

/// "Try asking" and the three suggestions, with a tail pointing at the button.
struct SuggestionBubble: View {
    /// How far the button's center is from the bubble's trailing edge.
    let tailFromTrailing: CGFloat
    let onPick: (Suggestion) -> Void
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Try asking")
                .romeFont(12, .semibold)
                .foregroundStyle(Palette.sub)
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 4)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(Suggestion.all.enumerated()), id: \.element.id) { index, suggestion in
                Button { onPick(suggestion) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: suggestion.systemImage)
                            .romeFont(14, .medium)
                            .foregroundStyle(Palette.primaryIcon)
                            .frame(width: 22)
                            .accessibilityHidden(true)
                        Text(verbatim: suggestion.text)
                            .romeFont(15)
                            .foregroundStyle(Palette.fg)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .accessibilityHint("Sends this message")
                .opacity(shown ? 1 : 0)
                .offset(y: shown ? 0 : 6)
                .animation(.spring(response: 0.3, dampingFraction: 0.8).delay(0.03 * Double(index + 1)), value: shown)
            }
        }
        .padding(.bottom, 6)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(alignment: .bottomTrailing) {
            BubbleTail()
                .fill(Palette.elevated)
                .frame(width: 16, height: 8)
                .offset(x: -(tailFromTrailing - 8), y: 7.5)
                .accessibilityHidden(true)
        }
        .softElevation(radius: 18)
        .shadow(color: Palette.cardShadow, radius: 18, x: 0, y: 8)
        .onAppear { shown = true }
    }
}

/// A small downward triangle.
private struct BubbleTail: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
