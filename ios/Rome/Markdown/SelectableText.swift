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

/// A run of text blocks as one string. Its quote bars and list markers are
/// SwiftUI's, drawn under it.
struct SelectableRun {
    var text: NSAttributedString
}

/// The type a message's text is set in, as `MarkdownText` takes it.
struct SelectableTextStyle {
    /// The body's design size, before Dynamic Type.
    var fontSize: CGFloat = 16
    var lineSpacing: CGFloat = 5
    var color: UIColor
    var dynamicTypeSize: DynamicTypeSize = .large
    /// The screen's pixels per point: `Text` sizes to whole pixels.
    var displayScale: CGFloat = 2

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
        for (index, piece) in pieces.enumerated() {
            let start = out.length
            out.append(piece.text)
            // A paragraph's style covers its closing newline too.
            if index < pieces.count - 1 {
                // In the font of the line it ends, so it adds no height.
                let font = piece.text.length > 0 ? piece.text.attribute(.font, at: piece.text.length - 1, effectiveRange: nil) : nil
                out.append(NSAttributedString(string: "\n", attributes: font.map { [.font: $0] } ?? [:]))
            }
            out.addAttribute(.paragraphStyle, value: piece.style, range: NSRange(location: start, length: out.length - start))
        }
        return SelectableRun(text: FallbackAdvances.matched(out))
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
            // The marker's width as `Text` takes it, up to a whole pixel, so
            // each item's text starts where it does outside select mode.
            let scale = max(style.displayScale, 1)
            let measured = ((marker as NSString).size(withAttributes: [.font: markerFont]).width * scale).rounded(.up) / scale
            let width = max(markerColumn, measured)
            let textStart = indent + width + markerGap
            let paragraph = paragraphStyle(lineSpacing: style.lineSpacing)
            paragraph.firstLineHeadIndent = textStart
            paragraph.headIndent = textStart
            paragraph.paragraphSpacing = itemSpacing
            pieces.append(Piece(text: inline(item.text, size: size, weight: .regular, color: style.color, tasks: tasks),
                                style: paragraph))
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
                        // As `MarkdownParser.chip` draws it: a space after
                        // text, then (from iOS 18) a no-break space, the
                        // status mark, and the name between no-break spaces.
                        let spaced = TaskLink.spacesChip(after: out.string.last)
                        attributes[.foregroundColor] = UIColor(Palette.fg)
                        attributes[.backgroundColor] = UIColor(Palette.taskChip)
                        attributes[.link] = url
                        var lead = spaced ? " " : ""
                        if #available(iOS 18.0, *) { lead += "\u{00A0}" }
                        if !lead.isEmpty { out.append(NSAttributedString(string: lead, attributes: attributes)) }
                        var mark = attributes
                        mark[.attachment] = chipMark(info, size: (size * 0.8).rounded())
                        out.append(NSAttributedString(string: "\u{FFFC}", attributes: mark))
                        text = "\u{00A0}\(info.name.isEmpty ? written : info.name)\u{00A0}"
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

    /// A chip's status mark as an attachment: the SF symbol, or the running
    /// ring, at the size and on the baseline `TaskMarkStyle.mark` draws it,
    /// so the chip takes the same width in the text view as on screen.
    static func chipMark(_ info: TaskLinkInfo, size: CGFloat) -> NSTextAttachment {
        let attachment = NSTextAttachment()
        if info.tone == .running {
            let image = TaskMarkRing.image(size: size, frame: 0)
            attachment.image = image
            attachment.bounds = CGRect(x: 0, y: -size * 0.09, width: image.size.width, height: image.size.height)
        } else if let image = UIImage(systemName: info.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: size)) {
            attachment.image = image
            attachment.bounds = CGRect(x: 0, y: -(image.baselineOffsetFromBottom ?? 0), width: image.size.width, height: image.size.height)
        }
        return attachment
    }

    /// The paragraph around the character at `index` (UTF-16), without its
    /// break: a Markdown block's text, one list item, or a run of the
    /// guardian's own text between blank lines. Blocks are separate lines
    /// (`\n`); a line break inside a block is a line separator, and two in
    /// a row are a blank line.
    nonisolated static func paragraph(in text: String, at index: Int) -> NSRange {
        let string = text as NSString
        guard string.length > 0 else { return NSRange(location: 0, length: 0) }
        let at = min(max(index, 0), string.length - 1)
        let newline: unichar = 0x0A, separator: unichar = 0x2028
        func breaks(_ i: Int) -> Bool {
            let c = string.character(at: i)
            if c == newline { return true }
            guard c == separator else { return false }
            // A blank line: this separator next to another.
            return (i > 0 && string.character(at: i - 1) == separator)
                || (i + 1 < string.length && string.character(at: i + 1) == separator)
        }
        // A press on a break counts toward the text before it, else after.
        var probe = at
        if breaks(probe) {
            var back = probe
            while back > 0, breaks(back) { back -= 1 }
            if !breaks(back) { probe = back } else {
                while probe < string.length - 1, breaks(probe) { probe += 1 }
            }
        }
        var start = probe
        while start > 0, !breaks(start - 1) { start -= 1 }
        var end = probe
        while end < string.length, !breaks(end) { end += 1 }
        // Without its edges' spaces.
        let whitespace = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{2028}"))
        while start < end, let scalar = Unicode.Scalar(string.character(at: start)), whitespace.contains(scalar) { start += 1 }
        while end > start, let scalar = Unicode.Scalar(string.character(at: end - 1)), whitespace.contains(scalar) { end -= 1 }
        return NSRange(location: start, length: end - start)
    }

    /// `text` with its glyphs, fills and lines clear: laid over the same text
    /// drawn by SwiftUI, it selects it without drawing it a second time.
    static func invisible(_ text: NSAttributedString) -> NSAttributedString {
        let out = NSMutableAttributedString(attributedString: text)
        let all = NSRange(location: 0, length: out.length)
        out.addAttribute(.foregroundColor, value: UIColor.clear, range: all)
        out.removeAttribute(.backgroundColor, range: all)
        out.removeAttribute(.strikethroughStyle, range: all)
        out.removeAttribute(.underlineStyle, range: all)
        // A chip's mark keeps its place, drawn clear.
        out.enumerateAttribute(.attachment, in: all) { value, range, _ in
            guard let mark = value as? NSTextAttachment else { return }
            let clear = NSTextAttachment()
            clear.bounds = mark.bounds
            clear.image = UIGraphicsImageRenderer(size: mark.bounds.size).image { _ in }
            out.addAttribute(.attachment, value: clear, range: range)
        }
        return out
    }

    /// What Copy writes for `text` taken from these strings: its line
    /// breaks as newlines.
    nonisolated static func copied(_ text: String) -> String {
        // A task chip's mark is an attachment, which copies as nothing.
        text.replacingOccurrences(of: "\u{2028}", with: "\n").replacingOccurrences(of: "\u{FFFC}", with: "")
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
    /// Off for code, which keeps its lines and scrolls sideways instead.
    var wraps = true
    /// Where select mode opens a selection in this text, with the edit menu
    /// up; nil opens none.
    var start: SelectionStart? = nil
    /// The selection's colour and its handles'.
    var tint: UIColor = UIColor(Palette.primary)

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SelectingTextView {
        let view = SelectingTextView(wraps: wraps)
        view.delegate = context.coordinator
        view.start = start
        return view
    }

    func updateUIView(_ view: SelectingTextView, context: Context) {
        context.coordinator.environment = context.environment
        view.tintColor = tint
        if !(view.attributedText?.isEqual(to: text) ?? false) {
            view.attributedText = text
            view.invalidateIntrinsicContentSize()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: SelectingTextView, context: Context) -> CGSize? {
        uiView.fittingSize(width: proposal.width, scale: context.environment.displayScale)
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

        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? SelectingTextView)?.selectionDidChange()
        }
    }
}

/// Where select mode opens its selection: the paragraph the long press that
/// opened the menu was on.
struct SelectionStart: Equatable {
    /// The long press, in the window; nil with none (VoiceOver, a keyboard).
    var point: CGPoint?
    /// This text is the message's first: with no point, it opens on its
    /// first paragraph, and it takes a press above it (on a quote or the
    /// bubble's padding).
    var first: Bool
    /// This text is the message's last: it takes a press below it.
    var last: Bool = true
    /// Where the bubble's fold hides the text, in the window; nil where it
    /// shows all of it. A selection never reaches past it.
    var foldBottom: CGFloat? = nil

    /// Whether a press `y` points down from this text's top, `top` to
    /// `bottom` in the same space, belongs to this text: within half the
    /// space between blocks of it, or anywhere above the first and below
    /// the last, so a press that misses the text still opens a selection.
    @MainActor
    static func claims(_ y: CGFloat, top: CGFloat, bottom: CGFloat, first: Bool, last: Bool) -> Bool {
        let slack = SelectableText.blockSpacing / 2
        return (first || y >= top - slack) && (last || y <= bottom + slack)
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
    var start: SelectionStart?
    private var selectedOnce = false
    #if DEBUG
    /// Tests only: select mode opens no selection, so what it draws can be
    /// compared with the text alone.
    static var opensSelection = true
    #else
    static let opensSelection = true
    #endif

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
        // A text view is a scroll view, which from iOS 26 blurs what is under
        // the status bar at its edges; this one never scrolls, and the blur
        // smeared its first line near the top of the screen.
        if #available(iOS 26, *) {
            topEdgeEffect.isHidden = true
            bottomEdgeEffect.isHidden = true
            leftEdgeEffect.isHidden = true
            rightEdgeEffect.isHidden = true
        }
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
    func fittingSize(width: CGFloat?, scale: CGFloat) -> CGSize {
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

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, start != nil, !selectedOnce, Self.opensSelection else { return }
        selectedOnce = true
        selectStart(tries: 4)
    }

    /// The paragraph select mode opens on, in this text: the one under the
    /// long press, else the first when the message's first text has no
    /// press to go by. Nil where the press was on other text.
    private var startRange: NSRange? {
        guard let start else { return nil }
        guard let point = start.point else {
            return start.first ? SelectableText.paragraph(in: textStorage.string, at: 0) : nil
        }
        let local = convert(point, from: nil)
        guard SelectionStart.claims(local.y, top: 0, bottom: bounds.height, first: start.first, last: start.last) else { return nil }
        // A press beside the text, on a quote or the padding, takes the
        // nearest paragraph; a press under the fold, the last one in sight.
        let lowest = min(bounds.height, visibleBottom ?? bounds.height) - 1
        let clamped = CGPoint(x: min(max(local.x, 0), bounds.width), y: min(max(local.y, 0), max(0, lowest)))
        guard let position = closestPosition(to: clamped) else { return nil }
        return SelectableText.paragraph(in: textStorage.string, at: offset(from: beginningOfDocument, to: position))
    }

    /// Selects the paragraph select mode opens on and shows the edit menu.
    /// The bubble's context menu may still be closing, and the text view
    /// cannot take focus until it has, so it tries again a moment later.
    private func selectStart(tries: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + (tries == 4 ? 0 : 0.15)) { [weak self] in
            guard let self, self.window != nil, let range = self.startRange, range.length > 0 else { return }
            guard self.isFirstResponder || self.becomeFirstResponder() else {
                if tries > 1 { self.selectStart(tries: tries - 1) }
                return
            }
            self.selectedRange = range
            self.clampToFold()
            self.startAutoscroll()
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

    // MARK: Edge auto-scroll

    private var lastRange = NSRange(location: 0, length: 0)
    /// Whether the finger holds the selection's start, else its end.
    private var movingStart = false
    private var autoscroll: CADisplayLink?

    /// Where the fold hides this text, down from its top; nil where none does.
    var visibleBottom: CGFloat? {
        guard let bottom = start?.foldBottom, window != nil else { return nil }
        return convert(CGPoint(x: 0, y: bottom), from: nil).y
    }

    /// Keeps the selection's end above the fold: text the fold hides can be
    /// neither seen nor dragged to, so it is not selected.
    private func clampToFold() {
        guard let limit = visibleBottom, let range = selectedTextRange, limit < bounds.height else { return }
        let last = closestPosition(to: CGPoint(x: bounds.width, y: max(0, limit - 4))) ?? range.end
        guard compare(range.end, to: last) == .orderedDescending else { return }
        let end = compare(last, to: range.start) == .orderedAscending ? range.start : last
        if let clamped = textRange(from: range.start, to: end) { selectedTextRange = clamped }
    }

    func selectionDidChange() {
        clampToFold()
        let range = selectedRange
        if range != lastRange {
            // The end that moved is the one the finger holds.
            movingStart = range.location != lastRange.location && NSMaxRange(range) == NSMaxRange(lastRange)
            lastRange = range
        }
        if selectedRange.length > 0 { startAutoscroll() }
    }

    /// The gesture under way on the view or its handles, if any: one that
    /// is moving before one that has only begun, whose place may be stale
    /// (the loupe's stays where a long press began while a handle moves).
    private static func tracking(_ view: UIView) -> UIGestureRecognizer? {
        let active = recognizers(in: view).filter { $0.state == .began || $0.state == .changed }
        return active.first { $0.state == .changed } ?? active.first
    }

    private static func recognizers(in view: UIView) -> [UIGestureRecognizer] {
        (view.gestureRecognizers ?? []) + view.subviews.flatMap { recognizers(in: $0) }
    }

    /// While a finger drags a selection past the top or bottom of what the
    /// transcript shows, it scrolls, and the held end follows the finger
    /// into the text that comes into view. UIKit scrolls a text view that
    /// scrolls itself, not the scroll view around one that does not. It
    /// watches for a drag for as long as the text holds a selection: a
    /// handle's drag reports no change of selection until it ends.
    private func startAutoscroll() {
        guard autoscroll == nil, Self.enclosingScrollView(of: self) != nil else { return }
        let link = CADisplayLink(target: AutoscrollTarget(view: self), selector: #selector(AutoscrollTarget.tick(_:)))
        link.add(to: .main, forMode: .common)
        autoscroll = link
    }

    /// A selection's handle or loupe is being dragged in some text view.
    @MainActor static var dragging = false

    fileprivate func autoscrollTick() {
        guard let window, isFirstResponder, selectedRange.length > 0 else {
            Self.dragging = false
            autoscroll?.invalidate()
            autoscroll = nil
            return
        }
        let finger = Self.tracking(self)
        Self.dragging = finger != nil
        guard let finger, let scroll = Self.enclosingScrollView(of: self) else { return }
        let y = finger.location(in: window).y
        let visible = scroll.convert(scroll.bounds, to: window)
        let top = max(visible.minY, window.safeAreaInsets.top) + Self.edge
        let bottom = min(visible.maxY, window.bounds.height - window.safeAreaInsets.bottom) - Self.edge
        let step: CGFloat
        if y < top { step = -min(1, (top - y) / Self.edge) * Self.speed }
        else if y > bottom { step = min(1, (y - bottom) / Self.edge) * Self.speed }
        else { return }
        let minOffset = -scroll.adjustedContentInset.top
        let maxOffset = max(minOffset, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
        let offset = min(max(scroll.contentOffset.y + step, minOffset), maxOffset)
        guard offset != scroll.contentOffset.y else { return }
        scroll.contentOffset.y = offset
        // The held end goes where the finger now is in the text.
        guard let range = selectedTextRange, let point = closestPosition(to: finger.location(in: self)) else { return }
        let fixed = movingStart ? range.end : range.start
        let ordered = compare(point, to: fixed) == .orderedAscending ? (point, fixed) : (fixed, point)
        if let moved = textRange(from: ordered.0, to: ordered.1), moved != range { selectedTextRange = moved }
    }

    /// How near an edge the finger starts scrolling, and the most it scrolls a frame.
    private static let edge: CGFloat = 56
    private static let speed: CGFloat = 14

    /// The nearest scroll view around `view` that has more to show.
    private static func enclosingScrollView(of view: UIView) -> UIScrollView? {
        var next = view.superview
        while let current = next {
            if let scroll = current as? UIScrollView, scroll.isScrollEnabled,
               scroll.contentSize.height > scroll.bounds.height + 1 { return scroll }
            next = current.superview
        }
        return nil
    }
}

/// Drives `SelectingTextView`'s edge auto-scroll from a display link, which
/// holds its target strongly; this holds the view weakly.
@MainActor
private final class AutoscrollTarget: NSObject {
    weak var view: SelectingTextView?

    init(view: SelectingTextView) {
        self.view = view
    }

    @objc func tick(_ link: CADisplayLink) {
        guard let view else {
            // Gone mid-drag (its cell reused, select mode ended): a scroll
            // must end select mode again.
            SelectingTextView.dragging = false
            return link.invalidate()
        }
        view.autoscrollTick()
    }
}
