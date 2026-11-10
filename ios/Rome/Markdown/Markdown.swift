import SwiftUI

/// A block of Markdown. The parser covers what agents write in chat: paragraphs,
/// headings, bullet and numbered lists, quotes, fenced code, and rules.
enum MarkdownBlock: Hashable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case list(ordered: Bool, start: Int, items: [String])
    case quote(String)
    case code(language: String?, text: String)
    case rule
    /// `![alt](src)`, lifted out of its paragraph to stand at its place.
    case image(alt: String, src: String)
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var listItems: [String] = []
        var listOrdered = false
        var listStart = 1
        var quote: [String] = []
        var code: [String]?
        var codeLanguage: String?

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks += splitImages(paragraph.joined(separator: "\n"))
                paragraph = []
            }
        }
        func flushList() {
            if !listItems.isEmpty {
                blocks.append(.list(ordered: listOrdered, start: listStart, items: listItems))
                listItems = []
            }
        }
        func flushQuote() {
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
        }
        func flushAll() {
            flushParagraph()
            flushList()
            flushQuote()
        }

        for rawLine in source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let line = rawLine
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if var lines = code {
                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    blocks.append(.code(language: codeLanguage, text: lines.joined(separator: "\n")))
                    code = nil
                    codeLanguage = nil
                } else {
                    lines.append(line)
                    code = lines
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                codeLanguage = language.isEmpty ? nil : language
                code = []
                continue
            }
            if trimmed.isEmpty {
                flushAll()
                continue
            }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushAll()
                blocks.append(.rule)
                continue
            }
            if let heading = headingLevel(trimmed) {
                flushAll()
                blocks.append(.heading(level: heading.level, text: heading.text))
                continue
            }
            if trimmed.hasPrefix(">") {
                flushParagraph()
                flushList()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            if let bullet = bulletItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !listItems.isEmpty && listOrdered { flushList() }
                listOrdered = false
                listItems.append(bullet)
                continue
            }
            if let numbered = orderedItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !listItems.isEmpty && !listOrdered { flushList() }
                if listItems.isEmpty { listStart = numbered.number }
                listOrdered = true
                listItems.append(numbered.text)
                continue
            }
            if !listItems.isEmpty, line.hasPrefix("  ") || line.hasPrefix("\t") {
                // A continuation line of the last list item.
                listItems[listItems.count - 1] += " " + trimmed
                continue
            }
            flushList()
            flushQuote()
            paragraph.append(line)
        }
        if let lines = code {
            blocks.append(.code(language: codeLanguage, text: lines.joined(separator: "\n")))
        }
        flushAll()
        return blocks
    }

    nonisolated(unsafe) private static let imagePattern = try! NSRegularExpression(pattern: #"!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)"#)

    /// A paragraph's text with its Markdown images as blocks of their own.
    /// Only image syntax counts: a plain link to an image file stays a link.
    static func splitImages(_ text: String) -> [MarkdownBlock] {
        let nsText = text as NSString
        let matches = imagePattern.matches(in: text, range: NSRange(location: 0, length: nsText.length))
        guard !matches.isEmpty else { return [.paragraph(text)] }
        var blocks: [MarkdownBlock] = []
        var cursor = 0
        for match in matches {
            let before = nsText.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !before.isEmpty { blocks.append(.paragraph(before)) }
            blocks.append(.image(alt: nsText.substring(with: match.range(at: 1)), src: nsText.substring(with: match.range(at: 2))))
            cursor = match.range.location + match.range.length
        }
        let after = nsText.substring(from: cursor).trimmingCharacters(in: .whitespacesAndNewlines)
        if !after.isEmpty { blocks.append(.paragraph(after)) }
        return blocks
    }

    private static func headingLevel(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard (1...6).contains(level), line.count > level,
              line[line.index(line.startIndex, offsetBy: level)] == " "
        else { return nil }
        return (level, String(line.dropFirst(level + 1)))
    }

    private static func bulletItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ ", "• "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count))
        }
        return nil
    }

    private static func orderedItem(_ line: String) -> (number: Int, text: String)? {
        let digits = line.prefix(while: \.isNumber)
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return (Int(digits) ?? 1, String(rest.dropFirst(2)))
    }

    /// Inline Markdown (bold, italics, code, links) as styled text.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let marked = CJKEmphasis.mark(text)
        var result = (try? AttributedString(markdown: marked, options: options)) ?? AttributedString(marked)
        CJKEmphasis.apply(&result)
        for run in result.runs {
            if run.link != nil {
                result[run.range].foregroundColor = Palette.primaryText
            }
            if let intent = run.inlinePresentationIntent, intent.contains(.code) {
                result[run.range].backgroundColor = Palette.fill
            }
        }
        return result
    }

    /// The text without Markdown marks, for previews and accessibility.
    static func plain(_ text: String) -> String {
        String(inline(text).characters)
            .replacingOccurrences(of: "#", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Bold and italic next to Chinese and Japanese text. CommonMark's flanking
/// rule only closes `**` before a space or punctuation, so
/// `**防霜冻。**渭南` keeps its asterisks: the closer follows `。` and comes
/// before a letter. Text with a `*` run beside a CJK character has its
/// emphasis paired here instead: a run opens before any non-space and closes
/// after any non-space, and pairs with the nearest open run of its length.
/// The pairs go through the parser as private-use marks and become emphasis
/// afterwards. Text without one is left to the parser as it is.
enum CJKEmphasis {
    private static let strongOpen: Character = "\u{E000}"
    private static let strongClose: Character = "\u{E001}"
    private static let emphasisOpen: Character = "\u{E002}"
    private static let emphasisClose: Character = "\u{E003}"
    private static let marks: Set<Character> = [strongOpen, strongClose, emphasisOpen, emphasisClose]

    static func isCJK(_ character: Character?) -> Bool {
        guard let value = character?.unicodeScalars.first?.value else { return false }
        return (0x2E80...0x9FFF).contains(value)  // radicals, punctuation, kana, ideographs
            || (0xAC00...0xD7AF).contains(value)  // Hangul
            || (0xF900...0xFAFF).contains(value)  // compatibility ideographs
            || (0xFF00...0xFFEF).contains(value)  // fullwidth forms
            || (0x20000...0x3FFFF).contains(value)
    }

    private struct Run {
        let start: Int
        let length: Int
        let before: Character?
        let after: Character?
    }

    /// The text with its paired `*` runs replaced by marks, when a run sits
    /// beside a CJK character.
    static func mark(_ text: String) -> String {
        guard text.contains("*") else { return text }
        var chars = Array(text)
        var runs: [Run] = []
        var index = 0
        while index < chars.count {
            let character = chars[index]
            if character == "\\" {
                index += 2
            } else if character == "`" {
                // A code span keeps its asterisks.
                var ticks = 0
                while index + ticks < chars.count, chars[index + ticks] == "`" { ticks += 1 }
                var close = index + ticks
                var found: Int?
                while close < chars.count {
                    if chars[close] == "`" {
                        var count = 0
                        while close + count < chars.count, chars[close + count] == "`" { count += 1 }
                        if count == ticks { found = close + count; break }
                        close += count
                    } else {
                        close += 1
                    }
                }
                index = found ?? index + ticks
            } else if character == "*" {
                var length = 0
                while index + length < chars.count, chars[index + length] == "*" { length += 1 }
                runs.append(Run(
                    start: index,
                    length: length,
                    before: index > 0 ? chars[index - 1] : nil,
                    after: index + length < chars.count ? chars[index + length] : nil))
                index += length
            } else {
                index += 1
            }
        }
        guard runs.contains(where: { isCJK($0.before) || isCJK($0.after) }) else { return text }

        var open: [Run] = []
        var pairs: [(Run, Run)] = []
        for run in runs where run.length <= 3 {
            let canClose = run.before.map { !$0.isWhitespace } ?? false
            let canOpen = run.after.map { !$0.isWhitespace } ?? false
            if canClose, let match = open.lastIndex(where: { $0.length == run.length }) {
                pairs.append((open[match], run))
                open.removeSubrange(match...)
            } else if canOpen {
                open.append(run)
            }
        }
        guard !pairs.isEmpty else { return text }
        // Right to left, so earlier offsets stay valid.
        var edits: [(Run, [Character])] = []
        for (opener, closer) in pairs {
            switch opener.length {
            case 1:
                edits += [(opener, [emphasisOpen]), (closer, [emphasisClose])]
            case 2:
                edits += [(opener, [strongOpen]), (closer, [strongClose])]
            default:
                edits += [(opener, [strongOpen, emphasisOpen]), (closer, [emphasisClose, strongClose])]
            }
        }
        for (run, replacement) in edits.sorted(by: { $0.0.start > $1.0.start }) {
            chars.replaceSubrange(run.start..<run.start + run.length, with: replacement)
        }
        return String(chars)
    }

    /// Turns the marks `mark` left into emphasis, and removes them.
    static func apply(_ result: inout AttributedString) {
        guard result.characters.contains(where: { marks.contains($0) }) else { return }
        var spans: [(Range<AttributedString.Index>, InlinePresentationIntent)] = []
        var strong: [AttributedString.Index] = []
        var emphasis: [AttributedString.Index] = []
        var index = result.startIndex
        while index < result.endIndex {
            let next = result.characters.index(after: index)
            switch result.characters[index] {
            case strongOpen: strong.append(next)
            case emphasisOpen: emphasis.append(next)
            case strongClose:
                if let start = strong.popLast() { spans.append((start..<index, .stronglyEmphasized)) }
            case emphasisClose:
                if let start = emphasis.popLast() { spans.append((start..<index, .emphasized)) }
            default: break
            }
            index = next
        }
        for (range, intent) in spans where !range.isEmpty {
            let pieces = result[range].runs.map { ($0.range, $0.inlinePresentationIntent ?? []) }
            for (piece, existing) in pieces {
                result[piece].inlinePresentationIntent = existing.union(intent)
            }
        }
        while let mark = result.characters.firstIndex(where: { marks.contains($0) }) {
            result.removeSubrange(mark..<result.characters.index(after: mark))
        }
    }
}

/// Renders Markdown with the design's chat typography.
struct MarkdownText: View {
    let source: String
    var fontSize: CGFloat = 16
    var lineSpacing: CGFloat = 5
    var color: Color = Palette.fg

    private var blocks: [MarkdownBlock] { MarkdownParser.parse(source) }
    @State private var showViewer = false
    @State private var viewerStart = 0
    @Environment(\.instanceOrigin) private var origin
    @Environment(\.chatLinkOpener) private var linkOpener

    /// The message's images, for paging in the viewer.
    private var gallery: [ViewerImage] {
        blocks.enumerated().compactMap { position, block in
            if case .image(let alt, let src) = block, case let source = ImageSource(src: src, origin: origin), source != .rejected {
                return .markdown(source, alt: alt, src: src, position: position)
            }
            return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { position, block in
                view(for: block, at: position)
            }
        }
        .foregroundStyle(color)
        .tint(Palette.primaryText)
        // Links in the text: the shell's opener, else the system's.
        .environment(\.openURL, OpenURLAction { url in linkOpener?(url) ?? .systemAction })
        .fullScreenCover(isPresented: $showViewer) {
            PhotoViewer(images: gallery, start: viewerStart)
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock, at position: Int) -> some View {
        switch block {
        case .paragraph(let text):
            Text(MarkdownParser.inline(text))
                .romeFont(fontSize)
                .lineSpacing(lineSpacing)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            Text(MarkdownParser.inline(text))
                .romeFont(level <= 1 ? fontSize + 4 : (level == 2 ? fontSize + 2 : fontSize), .semibold)
                .lineSpacing(3)
                .padding(.top, 2)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: ordered ? "\(start + index)." : "•")
                            .romeFont(fontSize, ordered ? .regular : .bold, monospacedDigits: true)
                            .foregroundStyle(Palette.sub)
                            .frame(minWidth: 12, alignment: .trailing)
                        Text(MarkdownParser.inline(item))
                            .romeFont(fontSize)
                            .lineSpacing(lineSpacing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(Palette.sub.opacity(0.5)).frame(width: 3)
                Text(MarkdownParser.inline(text))
                    .romeFont(fontSize)
                    .foregroundStyle(Palette.sub)
                    .lineSpacing(lineSpacing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .romeFont(13, design: .monospaced)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
            }
            .background(Palette.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        case .rule:
            Rectangle().fill(Palette.hair).frame(height: 1).padding(.vertical, 4)
        case .image(let alt, let src):
            MarkdownImageView(source: ImageSource(src: src, origin: origin), alt: alt, src: src) {
                viewerStart = gallery.firstIndex { $0.matches(position: position) } ?? 0
                showViewer = true
            }
        }
    }
}
