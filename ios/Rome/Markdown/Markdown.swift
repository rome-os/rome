import SwiftUI

/// A block of Markdown. The parser covers what agents write in chat: paragraphs,
/// headings, bullet and numbered lists, quotes, fenced code, rules,
/// GitHub-flavoured tables and picture sets.
enum MarkdownBlock: Hashable {
    case paragraph(String)
    case heading(level: Int, text: String)
    /// A list. An item's `children` hold the lists nested under it.
    case list(ordered: Bool, start: Int, items: [ListItem])
    case quote(String)
    case code(language: String?, text: String)
    case rule
    /// `![alt](src)`, lifted out of its paragraph to stand at its place.
    case image(alt: String, src: String)
    /// A table: its header, how each column aligns, and its rows, each with
    /// as many cells as the header. Cells keep their inline Markdown.
    case table(header: [String], alignments: [TableAlignment], rows: [[String]])
    /// A ```` ```pictures ```` fence: one picture per line, laid out as a grid or a list.
    case pictures(layout: PictureLayout, items: [PictureItem])
}

/// One item of a list: its text, and the lists indented under it.
struct ListItem: Hashable {
    var text: String
    var children: [MarkdownBlock] = []
}

/// How a `pictures` fence lays its pictures out: `pictures list` is a list,
/// and a bare `pictures` is a grid.
enum PictureLayout: Hashable {
    case grid, list
}

/// One line of a `pictures` fence, `![title](address) note`.
struct PictureItem: Hashable {
    let alt: String
    let src: String
    let note: String
}

/// How a table column aligns, from its delimiter cell.
enum TableAlignment: Hashable {
    case leading, center, trailing
}

enum MarkdownParser {
    // Both parses are pure functions of the text, so a cache keyed by it can
    // never go stale. A bubble's body runs again for reasons that leave its
    // text alone (a theme change, its row's info, first layout of a page).
    private static let blocksCache = ParseCache<[MarkdownBlock]>()
    private static let inlineCache = ParseCache<AttributedString>()

    static func parse(_ source: String) -> [MarkdownBlock] {
        blocksCache.value(for: source, blocks)
    }

    private static func blocks(_ source: String) -> [MarkdownBlock] {
        PerfProbe.count("markdownParse")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        // The lists open at this point, outermost first. A list ends up in
        // the block list, or under the last item of the list before it.
        struct OpenList {
            let ordered: Bool
            let start: Int
            let indent: Int
            var items: [ListItem] = []
        }
        var lists: [OpenList] = []
        var quote: [String] = []
        var code: [String]?
        var codeLanguage: String?

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks += splitImages(paragraph.joined(separator: "\n"))
                paragraph = []
            }
        }
        func closeList() {
            let list = lists.removeLast()
            let block = MarkdownBlock.list(ordered: list.ordered, start: list.start, items: list.items)
            if lists.isEmpty {
                blocks.append(block)
            } else {
                lists[lists.count - 1].items[lists[lists.count - 1].items.count - 1].children.append(block)
            }
        }
        func flushList() {
            while !lists.isEmpty { closeList() }
        }
        // An item at `indent`: a sibling in the open list at that indent, or
        // the first item of a list nested under the last item when it is
        // indented past that item's marker. A marker of the other kind at the
        // same indent starts a new list.
        func addItem(_ text: String, ordered: Bool, number: Int, indent: Int) {
            while let last = lists.last, indent < last.indent, lists.count > 1 { closeList() }
            if let last = lists.last, indent <= last.indent, last.ordered != ordered { closeList() }
            if let last = lists.last, indent <= last.indent {
                lists[lists.count - 1].items.append(ListItem(text: text))
            } else {
                lists.append(OpenList(ordered: ordered, start: number, indent: indent, items: [ListItem(text: text)]))
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

        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var next = 0
        while next < lines.count {
            var line = lines[next]
            next += 1
            var trimmed = line.trimmingCharacters(in: .whitespaces)

            if var lines = code {
                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    blocks.append(fenced(language: codeLanguage, lines: lines, closed: true))
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
            // The two markers that bound a task's conclusion show nothing, as
            // on the web. A line they leave empty ends the block below, and the
            // rest of any other line is read as it stands. Any other HTML
            // comment is text like the rest.
            if line.contains("<!--") {
                line = line.replacingOccurrences(
                    of: "<!--\\s*/?rome:conclusion\\s*-->", with: "", options: .regularExpression)
                trimmed = line.trimmingCharacters(in: .whitespaces)
            }
            if trimmed.isEmpty {
                // A blank line between items, or before an indented line,
                // keeps the list open, so a nested list after it still nests.
                if !lists.isEmpty, let following = lines[next...].first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
                   following.hasPrefix(" ") || following.hasPrefix("\t") || isListItem(following.trimmingCharacters(in: .whitespaces)) {
                    flushParagraph()
                    flushQuote()
                    continue
                }
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
            // A table: a row of cells, then its delimiter row, then body rows
            // up to a blank line or a line without a pipe.
            if trimmed.contains("|"), next < lines.count, let alignments = delimiterRow(lines[next]) {
                let header = tableCells(trimmed)
                if header.count == alignments.count {
                    flushAll()
                    next += 1
                    var rows: [[String]] = []
                    while next < lines.count {
                        let row = lines[next].trimmingCharacters(in: .whitespaces)
                        guard !row.isEmpty, row.contains("|") else { break }
                        rows.append(fitted(tableCells(row), to: header.count))
                        next += 1
                    }
                    blocks.append(.table(header: header, alignments: alignments, rows: rows))
                    continue
                }
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
                addItem(bullet, ordered: false, number: 1, indent: indentation(line))
                continue
            }
            if let numbered = orderedItem(trimmed) {
                flushParagraph()
                flushQuote()
                addItem(numbered.text, ordered: true, number: numbered.number, indent: indentation(line))
                continue
            }
            if !lists.isEmpty, line.hasPrefix("  ") || line.hasPrefix("\t") {
                // A continuation line of the innermost open item.
                let last = lists.count - 1
                lists[last].items[lists[last].items.count - 1].text += " " + trimmed
                continue
            }
            flushList()
            flushQuote()
            paragraph.append(line)
        }
        if let lines = code {
            blocks.append(fenced(language: codeLanguage, lines: lines, closed: false))
        }
        flushAll()
        return blocks
    }

    /// A fenced block: a picture set when it is a `pictures` fence with a safe
    /// picture on at least one line, else code. `language` is the whole info
    /// string. `closed` is false for a fence the text ends inside.
    static func fenced(language: String?, lines: [String], closed: Bool) -> MarkdownBlock {
        pictureSet(language: language, lines: lines, closed: closed)
            ?? .code(language: language, text: lines.joined(separator: "\n"))
    }

    /// The picture set a `pictures` fence holds, or nil when the fence is
    /// another kind or no line yields a safe picture. A line is a Markdown
    /// image, then its note; any other line is skipped. An address the app
    /// would not load is skipped too, by the rules of `ImageSource`. The last
    /// line of a fence still open may be half written, so it waits.
    static func pictureSet(language: String?, lines: [String], closed: Bool) -> MarkdownBlock? {
        let words = (language ?? "").split(whereSeparator: \.isWhitespace).map { String($0) }
        guard words.first == "pictures" else { return nil }
        let layout: PictureLayout = words.count > 1 && words[1] == "list" ? .list : .grid
        let complete = closed ? lines : Array(lines.dropLast())
        var items: [PictureItem] = []
        for line in complete {
            let text = line.trimmingCharacters(in: .whitespaces) as NSString
            guard let match = imagePattern.firstMatch(in: text as String, range: NSRange(location: 0, length: text.length)),
                  match.range.location == 0
            else { continue }
            let src = text.substring(with: match.range(at: 2))
            guard ImageSource(src: src) != .rejected else { continue }
            items.append(PictureItem(
                alt: unescapedLabel(text.substring(with: match.range(at: 1))).trimmingCharacters(in: .whitespaces),
                src: src,
                note: text.substring(from: match.range.location + match.range.length).trimmingCharacters(in: .whitespaces)))
        }
        return items.isEmpty ? nil : .pictures(layout: layout, items: items)
    }

    /// A Markdown image. The label may hold backslash escapes (`\[1\]`), and the
    /// address one level of balanced parentheses (`Mount_Fuji_(Japan).jpg`). The
    /// web's `PICTURE_LINE` (`packages/web/src/lib/picture-set.ts`) reads the
    /// same grammar, so keep the two alike.
    nonisolated(unsafe) private static let imagePattern = try! NSRegularExpression(pattern: #"!\[((?:[^\]\\]|\\.)*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)"#)

    /// A label with its Markdown backslash escapes read: `\[1\]` shows as `[1]`.
    /// A backslash before anything but ASCII punctuation stays.
    static func unescapedLabel(_ text: String) -> String {
        var result = ""
        var escaped = false
        for character in text {
            if escaped {
                if !(character.isASCII && (character.isPunctuation || character.isSymbol)) { result.append("\\") }
                result.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else {
                result.append(character)
            }
        }
        if escaped { result.append("\\") }
        return result
    }

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
            blocks.append(.image(alt: unescapedLabel(nsText.substring(with: match.range(at: 1))), src: nsText.substring(with: match.range(at: 2))))
            cursor = match.range.location + match.range.length
        }
        let after = nsText.substring(from: cursor).trimmingCharacters(in: .whitespacesAndNewlines)
        if !after.isEmpty { blocks.append(.paragraph(after)) }
        return blocks
    }

    /// A row's cells: split at each pipe not escaped with a backslash, the
    /// outer pipes dropped, `\|` read as a pipe.
    static func tableCells(_ line: String) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|"), !row.hasSuffix("\\|") { row.removeLast() }
        var cells: [String] = []
        var cell = ""
        var escaped = false
        for character in row {
            if escaped {
                // Only a pipe loses its backslash; anything else keeps it for the inline pass.
                if character != "|" { cell.append("\\") }
                cell.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    /// A delimiter row's alignments, or nil when the line is not one: every
    /// cell is dashes with an optional colon at either end.
    static func delimiterRow(_ line: String) -> [TableAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") || trimmed.hasPrefix(":") || trimmed.hasPrefix("-") else { return nil }
        var alignments: [TableAlignment] = []
        for cell in tableCells(trimmed) {
            let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
            let dashes = cell.dropFirst(left ? 1 : 0).dropLast(right && cell.count > 1 ? 1 : 0)
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            alignments.append(left && right ? .center : right ? .trailing : .leading)
        }
        // One cell needs its pipe, or "---" alone is a rule.
        guard alignments.count > 1 || trimmed.contains("|") else { return nil }
        return alignments
    }

    /// A body row padded with empty cells, or cut, to the header's width.
    private static func fitted(_ cells: [String], to count: Int) -> [String] {
        cells.count >= count ? Array(cells.prefix(count)) : cells + Array(repeating: "", count: count - cells.count)
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

    /// The width of a line's leading whitespace, a tab counting as four spaces.
    private static func indentation(_ line: String) -> Int {
        var width = 0
        for character in line {
            if character == " " { width += 1 } else if character == "\t" { width += 4 } else { break }
        }
        return width
    }

    private static func isListItem(_ line: String) -> Bool {
        bulletItem(line) != nil || orderedItem(line) != nil
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
        inlineCache.value(for: text, styledInline)
    }

    /// Inline Markdown with each link drawn as its text, which opens nothing.
    static func inline(_ text: String, linksAsText: Bool) -> AttributedString {
        guard linksAsText else { return inline(text) }
        var result = inline(text)
        for run in result.runs where run.link != nil {
            result[run.range].link = nil
            result[run.range].foregroundColor = nil
        }
        return result
    }

    /// A paragraph's text where each link to a task chat, `[name](#rome-task=ID)`,
    /// is a chip: the task chat's status mark and its current name on one
    /// rounded faint fill (`Palette.taskChip`), the link's text only while the
    /// name is unknown. A task chat the chat does not know reads as plain text
    /// (docs/domains/chats.md#task-link). The text's own background can neither
    /// round nor hold an image, so `TaskChipRenderer` draws the fill behind the
    /// chip's runs; on iOS 17, which has no text renderer, the mark sits just
    /// before the tinted name.
    @MainActor
    static func text(_ source: String, linksAsText: Bool, tasks: TaskLinkStore?, marks: TaskMarkStyle) -> Text {
        let styled = inline(source, linksAsText: linksAsText)
        guard !linksAsText, let tasks, source.contains(TaskLink.prefix) else { return Text(styled) }
        var out: Text?
        var plain = AttributedString()
        // The last character drawn: a chip takes a space before it only after text.
        var previous: Character?
        func flush() {
            guard !plain.characters.isEmpty else { return }
            previous = plain.characters.last
            out = out.map { $0 + Text(plain) } ?? Text(plain)
            plain = AttributedString()
        }
        for run in styled.runs {
            guard let url = run.link, let id = TaskLink.chatId(of: url) else {
                plain.append(styled[run.range])
                continue
            }
            flush()
            let written = String(styled[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
            let chip = chip(id: id, written: written, tasks: tasks, marks: marks, spaced: TaskLink.spacesChip(after: previous))
            previous = "\u{00A0}"
            out = out.map { $0 + chip } ?? chip
        }
        flush()
        return out ?? Text(styled)
    }

    @MainActor
    private static func chip(id: String, written: String, tasks: TaskLinkStore, marks: TaskMarkStyle, spaced: Bool) -> Text {
        guard let info = tasks.info[id] else {
            // Not read yet, or none of this chat's: the link's own text.
            return Text(AttributedString(written.isEmpty ? String(localized: "Task") : written))
        }
        var name = AttributedString("\u{00A0}\(info.name.isEmpty ? written : info.name)\u{00A0}")
        name.foregroundColor = Palette.fg
        name.link = TaskLink.url(chatId: id)
        let chip: Text
        if #available(iOS 18.0, *) {
            // A no-break space before the mark pads the fill as the one after the name does.
            chip = (Text(verbatim: "\u{00A0}") + marks.mark(info) + Text(name)).customAttribute(TaskChipRun(id: id))
        } else {
            name.backgroundColor = Palette.taskChip
            chip = marks.mark(info) + Text(name)
        }
        return spaced ? Text(verbatim: " ") + chip : chip
    }

    /// The blocks with each image and picture set drawn as its description,
    /// so nothing is loaded.
    static func withoutImages(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
        blocks.compactMap { block in
            switch block {
            case .image(let alt, _):
                return alt.isEmpty ? nil : .paragraph(alt)
            case .pictures(_, let items):
                let alts = items.map(\.alt).filter { !$0.isEmpty }
                return alts.isEmpty ? nil : .paragraph(alts.joined(separator: "\n"))
            default:
                return block
            }
        }
    }

    private static func styledInline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        let marked = CJKEmphasis.mark(LinkTargets.bracketed(text))
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

/// Link targets with spaces. CommonMark ends a bare link target at its first
/// space, so `[f](/projects/my report.md)` is no link and shows as written,
/// and agents write them anyway. Each such target is wrapped in `<…>`, the
/// form that may hold spaces, before the text is parsed. A code span keeps
/// what it holds; code blocks never reach inline parsing.
enum LinkTargets {
    static func bracketed(_ text: String) -> String {
        guard text.contains("](") else { return text }
        let chars = Array(text)
        var out: [Character] = []
        out.reserveCapacity(chars.count + 8)
        var index = 0
        while index < chars.count {
            let character = chars[index]
            if character == "\\" {
                out.append(contentsOf: chars[index..<min(index + 2, chars.count)])
                index += 2
            } else if character == "`" {
                let end = codeSpanEnd(chars, at: index)
                out.append(contentsOf: chars[index..<end])
                index = end
            } else if character == "]", index + 1 < chars.count, chars[index + 1] == "(",
                      let found = spacedTarget(chars, from: index + 2) {
                out.append(contentsOf: "](" + found.target + ")")
                index = found.close + 1
            } else {
                out.append(character)
                index += 1
            }
        }
        return String(out)
    }

    /// Where the code span opening at `index` ends: past its closing run of
    /// as many backticks, or past the opening run when none closes it.
    private static func codeSpanEnd(_ chars: [Character], at index: Int) -> Int {
        var ticks = 0
        while index + ticks < chars.count, chars[index + ticks] == "`" { ticks += 1 }
        var close = index + ticks
        while close < chars.count {
            guard chars[close] == "`" else {
                close += 1
                continue
            }
            var count = 0
            while close + count < chars.count, chars[close + count] == "`" { count += 1 }
            if count == ticks { return close + count }
            close += count
        }
        return index + ticks
    }

    /// The link destination starting at `start`, rewritten as `<target>` and
    /// its title, when its target holds a space and no angle brackets; and the
    /// index of its closing parenthesis. Nil leaves it as written.
    private static func spacedTarget(_ chars: [Character], from start: Int) -> (target: String, close: Int)? {
        var depth = 0
        var end = start
        while end < chars.count {
            let character = chars[end]
            if character == "\n" { return nil }
            if character == "\\" {
                end += 2
                continue
            }
            // A quoted title after a blank may hold parentheses of its own.
            if character == "\"" || character == "'", end > start, chars[end - 1].isWhitespace,
               let close = chars[(end + 1)...].firstIndex(where: { $0 == character || $0 == "\n" }), chars[close] == character {
                end = close + 1
                continue
            }
            if character == "(" { depth += 1 }
            if character == ")" {
                if depth == 0 { break }
                depth -= 1
            }
            end += 1
        }
        guard end < chars.count else { return nil }
        let destination = String(chars[start..<end]).trimmingCharacters(in: .whitespaces)
        guard !destination.hasPrefix("<"), destination.contains(where: \.isWhitespace) else { return nil }
        var target = destination
        var title = ""
        // A title: `"…"`, `'…'` or `(…)` after the target.
        for (open, close) in [("\"", "\""), ("'", "'"), ("(", ")")] where destination.hasSuffix(close) {
            guard let start = destination.dropLast().range(of: " " + open, options: .backwards) else { continue }
            target = String(destination[..<start.lowerBound]).trimmingCharacters(in: .whitespaces)
            title = String(destination[start.lowerBound...])
            break
        }
        guard !target.isEmpty, target.contains(where: \.isWhitespace), !target.contains("<"), !target.contains(">") else { return nil }
        return ("<" + target + ">" + title, end)
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
            } else if character == "]", index + 1 < chars.count, chars[index + 1] == "(" {
                // A link's destination keeps its asterisks.
                var depth = 0
                var end = index + 1
                while end < chars.count {
                    if chars[end] == "(" { depth += 1 }
                    if chars[end] == ")" { depth -= 1; if depth == 0 { break } }
                    end += 1
                }
                index = end + 1
            } else if character == "<", let close = chars[index...].firstIndex(where: { $0 == ">" || $0.isWhitespace }),
                      chars[close] == ">", chars[index..<close].contains(where: { $0 == ":" || $0 == "@" }) {
                // An autolink, `<https://…>`, keeps them too.
                index = close + 1
            } else if Self.startsURL(chars, at: index) {
                // So does a bare URL, up to the next space.
                while index < chars.count, !chars[index].isWhitespace { index += 1 }
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
        // Only pairs beside CJK need the relaxed rule; the parser takes the rest.
        pairs = pairs.filter { opener, closer in
            isCJK(opener.before) || isCJK(opener.after) || isCJK(closer.before) || isCJK(closer.after)
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

    /// Whether a bare URL starts at `index`.
    private static func startsURL(_ chars: [Character], at index: Int) -> Bool {
        guard index == 0 || chars[index - 1].isWhitespace || chars[index - 1] == "(" else { return false }
        for scheme in ["https://", "http://", "www."] {
            let prefix = Array(scheme)
            if index + prefix.count <= chars.count, Array(chars[index..<index + prefix.count]) == prefix { return true }
        }
        return false
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
    /// Draws links as their text and images as their description, so the
    /// Markdown opens and loads nothing, as a chat card's must not.
    var textOnly = false
    /// Select mode (`TextSelection`): the text blocks are drawn as text views
    /// that select in part, the rest as they are.
    var selectable = false
    /// In select mode, where the long press that opened it was, in the
    /// window: the paragraph under it opens selected.
    var selectFrom: CGPoint? = nil
    /// In select mode, where a fold hides the text, down from its top.
    var foldBottom: CGFloat? = nil

    private var blocks: [MarkdownBlock] {
        let parsed = MarkdownParser.parse(source)
        return textOnly ? MarkdownParser.withoutImages(parsed) : parsed
    }
    /// The blocks select mode lays one text view over, a run at a time; the
    /// rest, code included, keep their place in it by their drawn height.
    static func isText(_ block: MarkdownBlock) -> Bool {
        switch block {
        case .paragraph, .heading, .list, .quote: true
        case .code, .rule, .image, .table, .pictures: false
        }
    }

    /// Whether select mode has text to select in `block`: words, or code.
    static func selects(_ block: MarkdownBlock) -> Bool {
        func words(_ text: String) -> Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        switch block {
        case .paragraph(let text), .heading(_, let text), .quote(let text), .code(_, let text): return words(text)
        case .list(_, _, let items): return items.contains { words($0.text) || $0.children.contains(where: selects) }
        case .rule, .image, .table, .pictures: return false
        }
    }

    /// Whether Markdown `source` has text select mode can select: a message
    /// of only pictures, a table or a rule has none.
    static func hasSelectableText(_ source: String) -> Bool {
        MarkdownParser.parse(source).contains(where: selects)
    }

    /// Where select mode opens in the block at `position`: whether it is the
    /// message's first or last selectable text, and the fold.
    private func selectionStart(at position: Int) -> SelectionStart {
        // The text views select mode lays out: text, and code.
        let selectable = blocks.map { block -> Bool in
            if case .code = block { return true }
            return Self.isText(block)
        }
        return SelectionStart(point: selectFrom,
                              first: !selectable[..<position].contains(true),
                              last: !selectable[(position + 1)...].contains(true),
                              foldBottom: foldBottom)
    }

    private var selectableStyle: SelectableTextStyle {
        SelectableTextStyle(fontSize: fontSize, lineSpacing: lineSpacing, color: UIColor(color), dynamicTypeSize: dynamicTypeSize, displayScale: displayScale)
    }

    /// The drawn height of each block select mode does not select, by place.
    @State private var blockHeights: [Int: CGFloat] = [:]
    @State private var viewer: PhotoViewerStart?
    @Environment(\.instanceOrigin) private var origin
    @Environment(\.chatLinkOpener) private var linkOpener
    @Environment(\.taskLinks) private var taskLinks
    @Environment(\.openTaskChat) private var openTaskChat
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale

    /// The message's images, for paging in the viewer.
    private var gallery: [ViewerImage] { Self.gallery(blocks, origin: origin) }

    /// The images of `blocks` in order, as the viewer pages through them.
    static func gallery(_ blocks: [MarkdownBlock], origin: URL?) -> [ViewerImage] {
        blocks.enumerated().flatMap { position, block -> [ViewerImage] in
            switch block {
            case .image(let alt, let src):
                let source = ImageSource(src: src, origin: origin)
                return source == .rejected ? [] : [ViewerImage.markdown(source, alt: alt, src: src, position: position)]
            case .pictures(_, let items):
                return items.enumerated().compactMap { index, item -> ViewerImage? in
                    let source = ImageSource(src: item.src, origin: origin)
                    return source == .rejected ? nil : ViewerImage.markdown(source, alt: item.alt, src: item.src, position: pictureKey(block: position, item: index))
                }
            default:
                return []
            }
        }
    }

    /// The viewer position of a set's picture. Negative, so it never meets the
    /// block position of an image.
    static func pictureKey(block: Int, item: Int) -> Int {
        -(block * 1_000 + item) - 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SelectableText.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { position, block in
                if Self.isText(block) {
                    view(for: block, at: position)
                } else {
                    // A block outside the overlay's runs of text (code, a
                    // picture): its height, as drawn, holds its place there.
                    view(for: block, at: position)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { blockHeights[position] = $0 }
                }
            }
        }
        // Select mode lays text views over the text, which select it but
        // draw none of it: the text on screen is the same before, during and
        // after, so nothing moves as select mode starts or ends.
        .overlay(alignment: .topLeading) {
            if selectable {
                VStack(alignment: .leading, spacing: SelectableText.blockSpacing) {
                    selectableBlocks
                }
            }
        }
        // Each text view finds the fold in it from its place in here.
        .coordinateSpace(.named(SelectableBlockView.space))
        .foregroundStyle(color)
        .tint(Palette.primaryText)
        // Links in the text: the shell's opener, else the system's.
        .environment(\.openURL, OpenURLAction { url in
            if textOnly { return .discarded }
            // A chip for a task chat opens it; the Concierge's link to one is no page.
            if let id = TaskLink.chatId(of: url) {
                openTaskChat?.run((chatId: id, title: taskLinks?.info[id]?.name ?? ""))
                return .handled
            }
            return linkOpener?.run(url) ?? .systemAction
        })
        // The task chats this text names are read for their chips.
        .task(id: source) {
            guard let taskLinks else { return }
            let ids = TaskLink.ids(in: source)
            if !ids.isEmpty { taskLinks.register(ids) }
        }
        .fullScreenCover(item: $viewer) { start in
            PhotoViewer(images: gallery, start: start.index)
        }
    }

    /// The blocks in select mode, laid over the text: each run of text one
    /// text view whose glyphs are clear, and the rest their place. A code
    /// block's text view is in its own scroll (`view(for:at:)`).
    @ViewBuilder
    private var selectableBlocks: some View {
        let segments = SelectableText.segments(blocks, style: selectableStyle, tasks: textOnly ? nil : taskLinks)
        let first = segments.firstIndex { if case .block = $0 { false } else { true } }
        let last = segments.lastIndex { if case .block = $0 { false } else { true } }
        ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
            switch segment {
            case .text(let run):
                // Its quote bars and list markers are SwiftUI's, below.
                SelectableBlockView(text: SelectableText.invisible(run.text), start: SelectionStart(point: selectFrom, first: index == first, last: index == last, foldBottom: foldBottom))
                    .padding(.top, SelectableText.topSpace(run.text))
            case .code(let position, _), .block(let position, _):
                // Its place only, as tall as the block drawn below, which
                // keeps its own state (a picture loading or failed): a new
                // copy of it here could take another height.
                Color.clear.frame(height: blockHeights[position] ?? 0)
            }
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock, at position: Int) -> some View {
        switch block {
        case .paragraph(let text):
            MarkdownParagraph(source: text, linksAsText: textOnly, tasks: taskLinks, fontSize: fontSize, lineSpacing: lineSpacing)
        case .heading(let level, let text):
            Text(MarkdownParser.inline(text, linksAsText: textOnly))
                .romeFont(level <= 1 ? fontSize + 4 : (level == 2 ? fontSize + 2 : fontSize), .semibold)
                .lineSpacing(3)
                .padding(.top, 2)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let ordered, let start, let items):
            MarkdownList(ordered: ordered, start: start, items: items, fontSize: fontSize, lineSpacing: lineSpacing, linksAsText: textOnly, tasks: taskLinks)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(Palette.sub.opacity(0.5)).frame(width: 3)
                Text(MarkdownParser.inline(text, linksAsText: textOnly))
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
                    // Select mode's text view lies over the code inside its
                    // scroll, so the code stays where it was scrolled to.
                    .overlay(alignment: .topLeading) {
                        if selectable {
                            SelectableBlockView(text: SelectableText.invisible(SelectableText.code(text, style: selectableStyle)),
                                                wraps: false, start: selectionStart(at: position))
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
            }
            .background(Palette.fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        case .rule:
            Rectangle().fill(Palette.hair).frame(height: 1).padding(.vertical, 4)
        case .image(let alt, let src):
            MarkdownImageView(source: ImageSource(src: src, origin: origin), alt: alt, src: src) {
                viewer = PhotoViewerStart(position: position, in: gallery)
            }
        case .table(let header, let alignments, let rows):
            MarkdownTable(header: header, alignments: alignments, rows: rows, fontSize: fontSize - 1, linksAsText: textOnly)
        case .pictures(let layout, let items):
            MarkdownPictureSet(layout: layout, items: items, fontSize: fontSize) { index in
                viewer = PhotoViewerStart(position: Self.pictureKey(block: position, item: index), in: gallery)
            }
        }
    }
}

/// A paragraph of Markdown text with its task link chips. While a chip in it
/// is active, the paragraph is drawn again for each frame of the running ring;
/// with none active, off screen or under Reduce Motion, it is drawn once and
/// the ring stands still.
struct MarkdownParagraph: View {
    let source: String
    let linksAsText: Bool
    let tasks: TaskLinkStore?
    let fontSize: CGFloat
    let lineSpacing: CGFloat
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.offScreen) private var offScreen

    var body: some View {
        if spins {
            TimelineView(.animation(minimumInterval: TaskMarkRing.frameInterval, paused: offScreen)) { context in
                let _ = PerfProbe.count("taskRingTick")
                paragraph(frame: TaskMarkRing.frame(at: context.date))
            }
        } else {
            paragraph(frame: 0)
        }
    }

    @ViewBuilder
    private func paragraph(frame: Int) -> some View {
        let marks = TaskMarkStyle.forText(fontSize, dynamicTypeSize, frame: frame)
        let text = MarkdownParser.text(source, linksAsText: linksAsText, tasks: tasks, marks: marks)
            .romeFont(fontSize)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
        if #available(iOS 18.0, *), hasChips {
            text.textRenderer(TaskChipRenderer())
        } else {
            text
        }
    }

    /// Whether this paragraph may draw a chip; the rest keep the plain text drawing.
    private var hasChips: Bool {
        !linksAsText && tasks != nil && source.contains(TaskLink.prefix)
    }

    /// Whether a chip in this paragraph is active and its ring may turn.
    private var spins: Bool {
        guard !linksAsText, !reduceMotion, let tasks else { return false }
        return TaskLink.ids(in: source).contains { tasks.info[$0]?.tone == .running }
    }
}

/// A list in the bubble. A nested list sits under its item's text, so each
/// level steps in by one marker's width. Every level uses the same filled dot.
struct MarkdownList: View {
    let ordered: Bool
    let start: Int
    let items: [ListItem]
    let fontSize: CGFloat
    let lineSpacing: CGFloat
    var linksAsText = false
    var tasks: TaskLinkStore?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: ordered ? "\(start + index)." : "•")
                        .romeFont(fontSize, ordered ? .regular : .bold, monospacedDigits: true)
                        .foregroundStyle(Palette.sub)
                        .frame(minWidth: 12, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 4) {
                        MarkdownParagraph(source: item.text, linksAsText: linksAsText, tasks: tasks, fontSize: fontSize, lineSpacing: lineSpacing)
                        ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
                            if case .list(let ordered, let start, let items) = child {
                                MarkdownList(ordered: ordered, start: start, items: items, fontSize: fontSize, lineSpacing: lineSpacing, linksAsText: linksAsText, tasks: tasks)
                            }
                        }
                    }
                }
            }
        }
    }}

/// A Markdown table in the bubble: the header in medium weight, hairlines
/// between rows, no borders or fills. Wider than the bubble, it scrolls
/// sideways inside it; a cell wraps past `maxColumn`.
struct MarkdownTable: View {
    let header: [String]
    let alignments: [TableAlignment]
    let rows: [[String]]
    var fontSize: CGFloat = 15
    var linksAsText = false

    /// The widest a column grows before its cells wrap.
    static let maxColumn: CGFloat = 220

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(horizontalSpacing: 16, verticalSpacing: 0) {
                GridRow(alignment: .firstTextBaseline) {
                    ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                        self.cell(cell, column: column, weight: .medium)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Rectangle().fill(Palette.hair).frame(height: 0.5).gridCellUnsizedAxes(.horizontal)
                    GridRow(alignment: .firstTextBaseline) {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            self.cell(cell, column: column, weight: .regular)
                        }
                    }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        // VoiceOver reads a row at a time, each cell under its header.
        .accessibilityRepresentation {
            VStack(alignment: .leading) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Text(verbatim: Self.spoken(row, header: header))
                }
            }
        }
    }

    private func cell(_ text: String, column: Int, weight: Font.Weight) -> some View {
        let alignment = column < alignments.count ? alignments[column] : .leading
        let frame: Alignment = alignment == .center ? .center : alignment == .trailing ? .trailing : .leading
        return CappedWidth(max: Self.maxColumn) {
            Text(MarkdownParser.inline(text, linksAsText: linksAsText))
                .romeFont(fontSize, weight)
                .lineSpacing(3)
                .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
        }
        .frame(maxWidth: .infinity, alignment: frame)
        .padding(.vertical, 7)
    }

    /// "Header: value, Header: value" for one row, as plain text.
    nonisolated static func spoken(_ row: [String], header: [String]) -> String {
        zip(header, row).map { name, value in
            let name = MarkdownParser.plain(name), value = MarkdownParser.plain(value)
            return name.isEmpty ? value : "\(name): \(value)"
        }.joined(separator: ", ")
    }
}

/// Its content at its natural width, up to `max`, past which it wraps or
/// is cut: a short text hugs, a long one stops at the cap.
struct CappedWidth: Layout {
    let max: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let ideal = child.sizeThatFits(.unspecified).width
        // Never past the width offered: between the header's buttons at the
        // largest text sizes, a name is cut there too.
        let offered = proposal.width ?? .infinity
        return child.sizeThatFits(ProposedViewSize(width: Swift.min(ideal, max, offered), height: nil))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
    }
}
