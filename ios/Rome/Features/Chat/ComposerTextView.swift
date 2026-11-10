import SwiftUI
import UIKit

/// The message field. A UIKit text view, because SwiftUI's field takes no
/// pasted image before iOS 27: here Paste (the edit menu or ⌘V) hands images
/// to `onPasteImages` and pastes text as usual.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    /// Gets the pasteboard's image items; nil leaves images alone.
    var onPasteImages: (([NSItemProvider]) -> Void)?
    /// The text without what an input method is still composing.
    var committedText: Binding<String>? = nil

    static let maxLines = 6

    func makeUIView(context: Context) -> PastingTextView {
        let view = PastingTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textContainer.lineFragmentPadding = 0
        let inset = Self.verticalInset(lineHeight: Self.font(for: context.environment.dynamicTypeSize).lineHeight)
        view.textContainerInset = UIEdgeInsets(top: inset, left: 0, bottom: inset, right: 0)
        view.isScrollEnabled = false
        view.tintColor = UIColor(Palette.primary)
        view.textColor = UIColor(Palette.fg)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityLabel = placeholder
        return view
    }

    func updateUIView(_ view: PastingTextView, context: Context) {
        context.coordinator.parent = self
        let font = Self.font(for: context.environment.dynamicTypeSize)
        if view.font != font { view.font = font }
        let inset = Self.verticalInset(lineHeight: font.lineHeight)
        if view.textContainerInset.top != inset {
            view.textContainerInset = UIEdgeInsets(top: inset, left: 0, bottom: inset, right: 0)
        }
        if view.text != text { view.text = text }
        view.placeholder = placeholder
        view.accessibilityLabel = placeholder
        view.onPasteImages = onPasteImages
        if let committedText, view.markedTextRange == nil, committedText.wrappedValue != text {
            DispatchQueue.main.async { committedText.wrappedValue = text }
        }
        // Disabled (a blank chat while it is being created): focus goes now,
        // through UIKit. A disabled field loses focus silently otherwise and
        // leaves its keyboard up with no owner, which nothing can put away.
        guard context.environment.isEnabled else {
            if view.isFirstResponder { view.resignFirstResponder() }
            if focused { DispatchQueue.main.async { focused = false } }
            return
        }
        // Focus follows the binding both ways; the change waits a turn so it
        // never happens while SwiftUI is updating.
        if focused != view.isFirstResponder {
            DispatchQueue.main.async {
                if focused { view.becomeFirstResponder() } else { view.resignFirstResponder() }
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PastingTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 240
        let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let lineHeight = (view.font ?? Self.font(for: context.environment.dynamicTypeSize)).lineHeight
        let cap = lineHeight * CGFloat(Self.maxLines) + view.textContainerInset.top + view.textContainerInset.bottom
        let scrolls = fitting.height > cap
        if view.isScrollEnabled != scrolls {
            DispatchQueue.main.async { view.isScrollEnabled = scrolls }
        }
        return CGSize(width: width, height: min(fitting.height, cap))
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    /// 16 pt at the default text size, scaled the way `romeFont` scales.
    static func font(for size: DynamicTypeSize) -> UIFont {
        .systemFont(ofSize: ScaledFont.scaled(16, for: size))
    }

    /// The composer's height with one line of text, at the default text size.
    static let minHeight: CGFloat = 50

    /// Space above and below the text: one line fills `minHeight` exactly,
    /// centered, and a larger text size keeps at least 14 pt.
    static func verticalInset(lineHeight: CGFloat) -> CGFloat {
        max(14, (minHeight - lineHeight) / 2)
    }

    /// The gap under a control of `height` beside the field, so it is
    /// centered on the field's last line: on the only line it is centered in
    /// the composer, at every text size.
    static func controlBottomPadding(height: CGFloat, size: DynamicTypeSize) -> CGFloat {
        let lineHeight = font(for: size).lineHeight
        return verticalInset(lineHeight: lineHeight) + lineHeight / 2 - height / 2
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView

        init(parent: ComposerTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.committedText?.wrappedValue = Self.committed(in: textView)
            (textView as? PastingTextView)?.setNeedsDisplay()
            // Past six lines it scrolls: keep the caret in view.
            if textView.isScrollEnabled { textView.scrollRangeToVisible(textView.selectedRange) }
        }

        /// The text minus the marked (uncommitted) range.
        static func committed(in textView: UITextView) -> String {
            guard let marked = textView.markedTextRange else { return textView.text }
            let start = textView.offset(from: textView.beginningOfDocument, to: marked.start)
            let length = textView.offset(from: marked.start, to: marked.end)
            let text = textView.text as NSString
            return text.replacingCharacters(in: NSRange(location: start, length: length), with: "")
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.focused { parent.focused = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.focused { parent.focused = false }
        }
    }
}

/// A text view that pastes images out of the field and shows a placeholder.
final class PastingTextView: UITextView {
    var onPasteImages: (([NSItemProvider]) -> Void)?
    var placeholder = "" { didSet { setNeedsDisplay() } }
    /// The general pasteboard; tests give it their own.
    var pasteboard: UIPasteboard = .general

    override var text: String! { didSet { setNeedsDisplay() } }
    override var font: UIFont? { didSet { setNeedsDisplay() } }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteImages != nil, pasteboard.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if let onPasteImages, pasteboard.hasImages {
            // Providers, not `images`: those would decode every picture here.
            onPasteImages(pasteboard.itemProviders)
            // Text copied along with the images still lands in the field.
            if pasteboard.hasStrings, let string = pasteboard.string, !string.isEmpty { insertText(string) }
            return
        }
        super.paste(sender)
    }

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        guard text.isEmpty, !placeholder.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font ?? .systemFont(ofSize: 16),
            .foregroundColor: UIColor.placeholderText,
        ]
        let origin = CGPoint(x: textContainerInset.left + textContainer.lineFragmentPadding, y: textContainerInset.top)
        (placeholder as NSString).draw(at: origin, withAttributes: attributes)
    }
}
