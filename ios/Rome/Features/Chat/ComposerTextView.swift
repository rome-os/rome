import SwiftUI
import UIKit

/// The message field. A UIKit text view, because SwiftUI's field takes no
/// pasted image before iOS 27: here Paste (the edit menu or ⌘V) hands images
/// to `onPasteImages` and pastes text as usual.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    /// Nil leaves images on the pasteboard alone.
    var onPasteImages: (([UIImage]) -> Void)?

    static let maxLines = 6

    func makeUIView(context: Context) -> PastingTextView {
        let view = PastingTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 14, left: 0, bottom: 14, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
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
        if view.text != text { view.text = text }
        view.placeholder = placeholder
        view.onPasteImages = onPasteImages
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

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView

        init(parent: ComposerTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            (textView as? PastingTextView)?.setNeedsDisplay()
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
    var onPasteImages: (([UIImage]) -> Void)?
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
        if let onPasteImages, pasteboard.hasImages, let images = pasteboard.images, !images.isEmpty {
            onPasteImages(images)
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
