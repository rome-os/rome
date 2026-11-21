import SwiftUI
import CoreText
import UIKit

// A message's text in select mode (`TextSelection`): the same blocks as
// `MarkdownText` draws, as attributed strings a read-only `UITextView` can
// select in part. Each block keeps the look of its SwiftUI drawing: sizes,
// weights, colours, line and paragraph spacing, list indents and quotes.

/// One piece of a message in select mode, top to bottom.
enum SelectableSegment {
    /// A run of text blocks (paragraphs, headings, lists, quotes) in one text
    /// view, so a selection can cross them.
    case text(SelectableRun)
    /// A fenced code block: its own text view, unwrapped, which scrolls sideways.
    case code(NSAttributedString)
    /// A block that is not text (a table, an image, a picture set, a rule),
    /// drawn as outside select mode. `position` is its place in the message.
    case block(position: Int, MarkdownBlock)
}

/// A run of text blocks as one string, and what is drawn beside the text.
struct SelectableRun {
    var text: NSAttributedString
    /// The quote blocks' ranges, which draw their bar beside them.
    var quotes: [NSRange] = []
    /// The list items' markers, drawn in the indent before each item's
    /// first line. Kept out of the text, so an item breaks its lines as
    /// `Text` does and Copy takes the item's words alone.
    var markers: [ListMarker] = []
}

/// A list item's number or bullet.
struct ListMarker: Equatable {
    /// Where its item's text starts.
    let location: Int
    let text: NSAttributedString
    /// Its right edge, from the text view's leading edge.
    let trailing: CGFloat
}

/// The type a message's text is set in, as `MarkdownText` takes it.
struct SelectableTextStyle {
    /// The body's design size, before Dynamic Type.
    var fontSize: CGFloat = 16
    var lineSpacing: CGFloat = 5
    var color: UIColor
    var dynamicTypeSize: DynamicTypeSize = .large

    /// A design size at this text size, as `romeFont` scales it.
    func scaled(_ size: CGFloat) -> CGFloat { ScaledFont.scaled(size, for: dynamicTypeSize) }
}

@MainActor
enum SelectableText {
    /// The space between blocks, `MarkdownText`'s stack spacing.
    static let blockSpacing: CGFloat = 10
    /// The space between a list's items, and above a nested list.
    static let itemSpacing: CGFloat = 4
    /// A quote's text starts past its 3 pt bar and the 10 pt beside it.
    static let quoteIndent: CGFloat = 13
    /// A list marker's narrowest column, and the space after it.
    static let markerColumn: CGFloat = 12
    static let markerGap: CGFloat = 8

    /// The guardian's own message: plain text, no Markdown.
    static func plain(_ text: String, style: SelectableTextStyle) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        // As `Text` breaks lines: no lone short word on the last line.
        paragraph.lineBreakStrategy = .standard
        paragraph.lineSpacing = style.lineSpacing
        return FallbackAdvances.matched(NSAttributedString(string: lineBreaks(text), attributes: [
            .font: UIFont.systemFont(ofSize: style.scaled(style.fontSize)),
            .foregroundColor: style.color,
            .paragraphStyle: paragraph,
        ]))
    }

    /// The message's blocks as segments: each run of text blocks one text
    /// view, each code block one, and the rest drawn as they are.
    static func segments(_ blocks: [MarkdownBlock], style: SelectableTextStyle, tasks: TaskLinkStore? = nil) -> [SelectableSegment] {
        var segments: [SelectableSegment] = []
        var run: [MarkdownBlock] = []
        func flush() {
            guard !run.isEmpty else { return }
            segments.append(.text(attributed(run, style: style, tasks: tasks)))
            run = []
        }
        for (position, block) in blocks.enumerated() {
            switch block {
            case .paragraph, .heading, .list, .quote:
                run.append(block)
            case .code(_, let text):
                flush()
                segments.append(.code(code(text, style: style)))
            case .rule, .image, .table, .pictures:
                flush()
                segments.append(.block(position: position, block))
            }
        }
        flush()
        return segments
    }

    /// A run of text blocks as one string, with its quotes and list markers.
    static func attributed(_ blocks: [MarkdownBlock], style: SelectableTextStyle, tasks: TaskLinkStore? = nil) -> SelectableRun {
        var pieces: [Piece] = []
        var quoteIndices: [Int] = []
        for block in blocks {
            switch block {
            case .paragraph(let text):
                pieces.append(Piece(text: inline(text, size: style.scaled(style.fontSize), weight: .regular, color: style.color, tasks: tasks),
                                    style: paragraphStyle(lineSpacing: style.lineSpacing)))
            case .heading(let level, let text):
                let size = level <= 1 ? style.fontSize + 4 : (level == 2 ? style.fontSize + 2 : style.fontSize)
                let paragraph = paragraphStyle(lineSpacing: 3)
                paragraph.paragraphSpacingBefore = 2
                pieces.append(Piece(text: inline(text, size: style.scaled(size), weight: .semibold, color: style.color, tasks: tasks), style: paragraph))
            case .list(let ordered, let start, let items):
                list(ordered: ordered, start: start, items: items, indent: 0, style: style, tasks: tasks, into: &pieces)
            case .quote(let text):
                let paragraph = paragraphStyle(lineSpacing: style.lineSpacing)
                paragraph.firstLineHeadIndent = quoteIndent
                paragraph.headIndent = quoteIndent
                quoteIndices.append(pieces.count)
                pieces.append(Piece(text: inline(text, size: style.scaled(style.fontSize), weight: .regular, color: UIColor(Palette.sub), tasks: tasks),
                                    style: paragraph))
            case .code, .rule, .image, .table, .pictures:
                continue
            }
            // The block's last paragraph keeps the stack's spacing below it.
            pieces[pieces.count - 1].style.paragraphSpacing = blockSpacing
        }
        // Nothing follows the last one in its text view.
        if !pieces.isEmpty { pieces[pieces.count - 1].style.paragraphSpacing = 0 }

        let out = NSMutableAttributedString()
        var quotes: [NSRange] = []
        var markers: [ListMarker] = []
        for (index, piece) in pieces.enumerated() {
            let start = out.length
            out.append(piece.text)
            if quoteIndices.contains(index) { quotes.append(NSRange(location: start, length: piece.text.length)) }
            if let marker = piece.marker {
                markers.append(ListMarker(location: start, text: marker.text, trailing: marker.trailing))
            }
            // A paragraph's style covers its closing newline too.
            if index < pieces.count - 1 {
                // In the font of the line it ends, so it adds no height.
                let font = piece.text.length > 0 ? piece.text.attribute(.font, at: piece.text.length - 1, effectiveRange: nil) : nil
                out.append(NSAttributedString(string: "\n", attributes: font.map { [.font: $0] } ?? [:]))
            }
            out.addAttribute(.paragraphStyle, value: piece.style, range: NSRange(location: start, length: out.length - start))
        }
        return SelectableRun(text: FallbackAdvances.matched(out), quotes: quotes, markers: markers)
    }

    /// The space above the first paragraph a text view leaves out, which a
    /// heading on top asks for: the view is padded by it instead.
    static func topSpace(_ text: NSAttributedString) -> CGFloat {
        guard text.length > 0 else { return 0 }
        return (text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacingBefore ?? 0
    }

    /// A fenced block's text, as `MarkdownText` sets it.
    static func code(_ text: String, style: SelectableTextStyle) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        // As `Text` breaks lines: no lone short word on the last line.
        paragraph.lineBreakStrategy = .standard
        paragraph.lineSpacing = 4
        return FallbackAdvances.matched(NSAttributedString(string: lineBreaks(text), attributes: [
            .font: UIFont.monospacedSystemFont(ofSize: style.scaled(13), weight: .regular),
            .foregroundColor: style.color,
            .paragraphStyle: paragraph,
        ]))
    }

    /// One paragraph of the run, before they are joined.
    private struct Piece {
        var text: NSAttributedString
        var style: NSMutableParagraphStyle
        /// A list item's marker, and its right edge.
        var marker: (text: NSAttributedString, trailing: CGFloat)?
    }

    private static func paragraphStyle(lineSpacing: CGFloat) -> NSMutableParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        // As `Text` breaks lines: no lone short word on the last line.
        paragraph.lineBreakStrategy = .standard
        paragraph.lineSpacing = lineSpacing
        return paragraph
    }

    /// A list's items, each one paragraph past its marker, which sits
    /// right-aligned in a column of at least `markerColumn`; nested lists
    /// under the item's text.
    private static func list(
        ordered: Bool, start: Int, items: [ListItem], indent: CGFloat,
        style: SelectableTextStyle, tasks: TaskLinkStore?, into pieces: inout [Piece]
    ) {
        let size = style.scaled(style.fontSize)
        let markerFont = ordered ? UIFont.monospacedDigitSystemFont(ofSize: size, weight: .regular) : UIFont.systemFont(ofSize: size, weight: .bold)
        for (index, item) in items.enumerated() {
            let marker = ordered ? "\(start + index)." : "•"
            let width = max(markerColumn, (marker as NSString).size(withAttributes: [.font: markerFont]).width)
            let textStart = indent + width + markerGap
            let paragraph = paragraphStyle(lineSpacing: style.lineSpacing)
            paragraph.firstLineHeadIndent = textStart
            paragraph.headIndent = textStart
            paragraph.paragraphSpacing = itemSpacing
            let drawn = NSAttributedString(string: marker, attributes: [.font: markerFont, .foregroundColor: UIColor(Palette.sub)])
            pieces.append(Piece(text: inline(item.text, size: size, weight: .regular, color: style.color, tasks: tasks),
                                style: paragraph, marker: (drawn, indent + width)))
            for child in item.children {
                if case .list(let ordered, let start, let items) = child {
                    list(ordered: ordered, start: start, items: items, indent: textStart, style: style, tasks: tasks, into: &pieces)
                }
            }
        }
    }

    /// Inline Markdown as `MarkdownParser.inline` reads it, with the fonts
    /// SwiftUI gives its runs: bold, italic, code in monospace on its fill,
    /// links in the link colour. A link to a task chat this chat knows reads
    /// as the task chat's name on the chip's fill; its status mark is left out.
    static func inline(_ source: String, size: CGFloat, weight: UIFont.Weight, color: UIColor, tasks: TaskLinkStore? = nil) -> NSAttributedString {
        let styled = MarkdownParser.inline(source)
        let chips = tasks != nil && source.contains(TaskLink.prefix)
        let out = NSMutableAttributedString()
        for run in styled.runs {
            var text = String(styled[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font(size: size, weight: weight, intent: intent),
                .foregroundColor: color,
            ]
            if intent.contains(.code) { attributes[.backgroundColor] = UIColor(Palette.fill) }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let url = run.link {
                if chips, let tasks, let id = TaskLink.chatId(of: url) {
                    let written = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let info = tasks.info[id] {
                        let spaced = TaskLink.spacesChip(after: out.string.last)
                        text = (spaced ? " " : "") + "\u{00A0}\(info.name.isEmpty ? written : info.name)\u{00A0}"
                        attributes[.foregroundColor] = UIColor(Palette.fg)
                        attributes[.backgroundColor] = UIColor(Palette.taskChip)
                        attributes[.link] = url
                    } else {
                        // Not read yet, or none of this chat's: the link's own text.
                        text = written.isEmpty ? String(localized: "Task") : written
                    }
                } else {
                    attributes[.foregroundColor] = UIColor(Palette.primaryText)
                    attributes[.link] = url
                }
            }
            out.append(NSAttributedString(string: lineBreaks(text), attributes: attributes))
        }
        return out
    }

    /// What Copy writes for `text` taken from these strings: its line
    /// breaks as newlines.
    nonisolated static func copied(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{2028}", with: "\n")
    }

    /// A line break inside a block breaks the line, not the paragraph, so it
    /// takes the line spacing and not the space between blocks.
    private static func lineBreaks(_ text: String) -> String {
        text.replacingOccurrences(of: "\n", with: "\u{2028}")
    }

    private static func font(size: CGFloat, weight: UIFont.Weight, intent: InlinePresentationIntent) -> UIFont {
        let bold = intent.contains(.stronglyEmphasized)
        let resolved: UIFont.Weight = bold ? .bold : weight
        var font = intent.contains(.code)
            ? UIFont.monospacedSystemFont(ofSize: size, weight: resolved)
            : UIFont.systemFont(ofSize: size, weight: resolved)
        if intent.contains(.emphasized), let italic = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
            font = UIFont(descriptor: italic, size: size)
        }
        return font
    }
}

/// Gives characters the advances SwiftUI's `Text` gives them. CoreText, which
/// `Text` lays out with, tracks a fallback font (Chinese, Japanese) tighter
/// at small sizes than TextKit 1 does: PingFang at 16 pt is 15.88 pt a
/// character against 15.95, so a Chinese line fitted one character less and
/// the bubble came out wider. Each character outside ASCII gets the
/// difference as kerning; the system font's own match already.
@MainActor
enum FallbackAdvances {
    private struct Key: Hashable {
        let font: String
        let size: CGFloat
        let character: String
    }
    private static var cache: [Key: CGFloat] = [:]

    static func matched(_ text: NSAttributedString) -> NSAttributedString {
        let out = NSMutableAttributedString(attributedString: text)
        let string = text.string as NSString
        text.enumerateAttribute(.font, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let font = value as? UIFont else { return }
            string.enumerateSubstrings(in: range, options: .byComposedCharacterSequences) { character, characterRange, _, _ in
                guard let character, character.unicodeScalars.contains(where: { $0.value > 0x2000 }) else { return }
                let kern = difference(character, font: font)
                if kern != 0 { out.addAttribute(.kern, value: kern, range: characterRange) }
            }
        }
        return out
    }

    /// CoreText's advance for `character` in `font`, less TextKit 1's.
    static func difference(_ character: String, font: UIFont) -> CGFloat {
        let key = Key(font: font.fontName, size: font.pointSize, character: character)
        if let known = cache[key] { return known }
        let single = NSAttributedString(string: character, attributes: [.font: font])
        let laid = CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(single), nil, nil, nil))
        let delta = laid - SelectingTextView.measure(single, width: .greatestFiniteMagnitude).width
        let result = abs(delta) < 0.001 ? 0 : delta
        if cache.count > 4_000 { cache.removeAll() }
        cache[key] = result
        return result
    }
}

// MARK: - The text view

/// A read-only text view that selects part of a message's text: the system
/// handles, its edit menu, and Copy as plain text. It sizes to its text the
/// way SwiftUI's `Text` does, so a bubble keeps its height in select mode.
struct SelectableTextView: UIViewRepresentable {
    let text: NSAttributedString
    var quotes: [NSRange] = []
    var markers: [ListMarker] = []
    /// Off for code, which keeps its lines and scrolls sideways instead.
    var wraps = true
    /// Opens with all of its text selected and the edit menu up.
    var selectsAll = false
    /// The selection's colour and its handles'.
    var tint: UIColor = UIColor(Palette.primary)

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SelectingTextView {
        let view = SelectingTextView(wraps: wraps)
        view.delegate = context.coordinator
        view.selectsAllOnAppear = selectsAll
        return view
    }

    func updateUIView(_ view: SelectingTextView, context: Context) {
        context.coordinator.environment = context.environment
        view.tintColor = tint
        if !(view.attributedText?.isEqual(to: text) ?? false) {
            view.attributedText = text
            view.invalidateIntrinsicContentSize()
        }
        view.quotes = quotes
        view.markers = markers
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SelectingTextView, context: Context) -> CGSize? {
        uiView.fittingSize(width: proposal.width)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var environment = EnvironmentValues()

        /// A tapped link opens as it does outside select mode, and ends it.
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            let environment = environment
            return UIAction { _ in
                environment.textSelection?.end()
                environment.openURL(url)
            }
        }
    }
}

/// Line spacing as SwiftUI's `Text` lays it: between the lines of a
/// paragraph only. TextKit 1 also adds it below a paragraph's last line,
/// which made each paragraph break 5 pt taller than outside select mode.
final class SelectableLayout: NSObject, NSLayoutManagerDelegate, Sendable {
    static let shared = SelectableLayout()

    func layoutManager(_ layoutManager: NSLayoutManager, lineSpacingAfterGlyphAt glyphIndex: Int, withProposedLineFragmentRect rect: CGRect) -> CGFloat {
        guard let storage = layoutManager.textStorage else { return 0 }
        let string = storage.string as NSString
        let index = layoutManager.characterIndexForGlyph(at: glyphIndex)
        guard index < string.length else { return 0 }
        // A line that ends its paragraph, or the text, takes none. The glyph
        // is the line's last drawn one, so the newline comes after it.
        if string.character(at: index) == 0x0A || index + 1 >= string.length || string.character(at: index + 1) == 0x0A { return 0 }
        return (storage.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle)?.lineSpacing ?? 0
    }
}

/// The text view under `SelectableTextView`, on TextKit 1, whose layout
/// reports the used height directly.
final class SelectingTextView: UITextView {
    private let wraps: Bool
    var selectsAllOnAppear = false
    private var selectedOnce = false
    var quotes: [NSRange] = [] {
        didSet { if quotes != oldValue { setNeedsLayout() } }
    }
    private var bars: [UIView] = []
    var markers: [ListMarker] = [] {
        didSet { if markers != oldValue { setNeedsLayout() } }
    }
    private var markerLabels: [UILabel] = []

    init(wraps: Bool) {
        self.wraps = wraps
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        layout.delegate = SelectableLayout.shared
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: wraps ? 0 : CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        container.widthTracksTextView = wraps
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        // Its selection handles reach past the text; a scroll view clips them.
        clipsToBounds = false
        textContainerInset = .zero
        dataDetectorTypes = []
        // The string carries each link's colour.
        linkTextAttributes = [:]
        adjustsFontForContentSizeCategory = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The text's size laid out in `width`: as wide as its widest line, up to
    /// `width`, and as tall as its lines. Rounded up to a pixel, so the text
    /// view, given that width back, breaks its lines in the same places.
    func fittingSize(width: CGFloat?) -> CGSize {
        let scale = window?.screen.scale ?? UITraitCollection.current.displayScale
        let limit = wraps ? (width.map { $0.isFinite ? $0 : .greatestFiniteMagnitude } ?? .greatestFiniteMagnitude) : .greatestFiniteMagnitude
        let measured = Self.measure(attributedText ?? NSAttributedString(), width: limit)
        func up(_ value: CGFloat) -> CGFloat { (value * max(scale, 1)).rounded(.up) / max(scale, 1) }
        let fitted = wraps ? min(up(measured.width), limit) : up(measured.width)
        return CGSize(width: fitted, height: up(measured.height))
    }

    /// The used size of `text` laid out by TextKit 1 at `width`.
    static func measure(_ text: NSAttributedString, width: CGFloat) -> CGSize {
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        layout.delegate = SelectableLayout.shared
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        // From the leading edge: an indented paragraph's lines start past it.
        let used = layout.usedRect(for: container)
        return CGSize(width: used.maxX, height: used.maxY)
    }

    /// Copy writes plain text.
    override func copy(_ sender: Any?) {
        guard let range = Range(selectedRange, in: text ?? ""), let text else { return }
        UIPasteboard.general.string = SelectableText.copied(String(text[range]))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        drawQuoteBars()
        drawMarkers()
    }

    /// Each list marker on its item's first baseline, right-aligned at its edge.
    private func drawMarkers() {
        while markerLabels.count < markers.count {
            let label = UILabel()
            label.isUserInteractionEnabled = false
            addSubview(label)
            markerLabels.append(label)
        }
        for (index, label) in markerLabels.enumerated() {
            guard index < markers.count, markers[index].location < textStorage.length else {
                label.isHidden = true
                continue
            }
            let marker = markers[index]
            let glyph = layoutManager.glyphIndexForCharacter(at: marker.location)
            let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let baseline = line.minY + layoutManager.location(forGlyphAt: glyph).y
            label.attributedText = marker.text
            label.isHidden = false
            let size = label.intrinsicContentSize
            let font = marker.text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
            label.frame = CGRect(x: marker.trailing - size.width, y: baseline - (font?.ascender ?? size.height), width: size.width, height: size.height)
        }
    }

    /// Each quote's bar, as tall as its text, at the leading edge.
    private func drawQuoteBars() {
        while bars.count < quotes.count {
            let bar = UIView()
            bar.layer.cornerRadius = 1.5
            bar.isUserInteractionEnabled = false
            addSubview(bar)
            bars.append(bar)
        }
        for (index, bar) in bars.enumerated() {
            guard index < quotes.count else {
                bar.isHidden = true
                continue
            }
            let glyphs = layoutManager.glyphRange(forCharacterRange: quotes[index], actualCharacterRange: nil)
            var top = CGFloat.greatestFiniteMagnitude
            var bottom: CGFloat = 0
            layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in
                top = min(top, used.minY)
                bottom = max(bottom, used.maxY)
            }
            bar.isHidden = bottom <= top
            bar.backgroundColor = UIColor(Palette.sub).withAlphaComponent(0.5)
            bar.frame = CGRect(x: 0, y: top, width: 3, height: max(0, bottom - top))
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, selectsAllOnAppear, !selectedOnce else { return }
        selectedOnce = true
        selectAllWithMenu(tries: 4)
    }

    /// Selects all of the text and shows the edit menu. The bubble's context
    /// menu may still be closing, and the text view cannot take focus until
    /// it has, so it tries again a moment later.
    private func selectAllWithMenu(tries: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + (tries == 4 ? 0 : 0.15)) { [weak self] in
            guard let self, self.window != nil else { return }
            guard self.isFirstResponder || self.becomeFirstResponder() else {
                if tries > 1 { self.selectAllWithMenu(tries: tries - 1) }
                return
            }
            self.selectedRange = NSRange(location: 0, length: self.textStorage.length)
            // After the bubble's menu has closed: one shown while it closes
            // is closed with it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.presentEditMenu() }
        }
    }

    /// The edit menu shown when select mode opens. The text view's own does
    /// not open when asked, only on a tap on the selection; one of its own
    /// gathers the same actions (Copy, Look Up, Translate, Share) from the
    /// text view as first responder.
    private lazy var openingMenu: UIEditMenuInteraction = {
        let menu = UIEditMenuInteraction(delegate: nil)
        addInteraction(menu)
        return menu
    }()

    private func presentEditMenu() {
        guard window != nil, isFirstResponder, selectedRange.length > 0 else { return }
        let rect = selectedTextRange.map { firstRect(for: $0) } ?? bounds
        let point = CGPoint(x: rect.isNull ? bounds.midX : rect.midX, y: rect.isNull ? bounds.minY : rect.minY)
        openingMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }
}
