import SwiftUI
import Testing
import UIKit
@testable import Rome

/// A message's text in select mode: each block as the text view draws it.
@MainActor
@Suite struct SelectableTextTests {
    let style = SelectableTextStyle(color: .black)

    private func run(_ source: String) -> SelectableRun {
        SelectableText.attributed(MarkdownParser.parse(source), style: style)
    }

    private func string(_ source: String) -> (NSAttributedString, [NSRange]) {
        let run = run(source)
        return (run.text, run.quotes)
    }

    private func paragraph(_ text: NSAttributedString, at location: Int) -> NSParagraphStyle? {
        text.attribute(.paragraphStyle, at: location, effectiveRange: nil) as? NSParagraphStyle
    }

    private func font(_ text: NSAttributedString, at location: Int) -> UIFont? {
        text.attribute(.font, at: location, effectiveRange: nil) as? UIFont
    }

    @Test func aParagraphKeepsTheBodyTypeAndLineSpacing() throws {
        let (text, _) = string("Hello there")
        #expect(text.string == "Hello there")
        let font = try #require(font(text, at: 0))
        #expect(font.pointSize == ScaledFont.scaled(16, for: .large))
        #expect(paragraph(text, at: 0)?.lineSpacing == 5)
    }

    @Test func blocksAreParagraphsTheStackSpacingApart() throws {
        let (text, _) = string("One\n\nTwo")
        #expect(text.string == "One\nTwo")
        #expect(paragraph(text, at: 0)?.paragraphSpacing == SelectableText.blockSpacing)
        // The last has nothing below it.
        #expect(paragraph(text, at: 4)?.paragraphSpacing == 0)
    }

    @Test func aLineBreakInsideABlockStaysInItsParagraph() {
        let (text, _) = string("First line\nsecond line")
        #expect(text.string == "First line\u{2028}second line")
    }

    @Test func aHeadingIsSemiboldAndLarger() throws {
        let (text, _) = string("# Title\n\nBody")
        let heading = try #require(font(text, at: 0))
        #expect(heading.pointSize == ScaledFont.scaled(20, for: .large))
        let traits = heading.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
        #expect(traits?[.weight] as? CGFloat == UIFont.Weight.semibold.rawValue)
        #expect(paragraph(text, at: 0)?.lineSpacing == 3)
        #expect(paragraph(text, at: 0)?.paragraphSpacingBefore == 2)
    }

    @Test func aListItemHasItsMarkerAndHangingIndent() throws {
        let run = run("- apples\n- pears\n  - green")
        // The markers are drawn beside the text, not in it.
        #expect(run.text.string == "apples\npears\ngreen")
        #expect(run.markers.map { $0.text.string } == ["•", "•", "•"])
        #expect(run.markers.map(\.location) == [0, 7, 13])
        let first = try #require(paragraph(run.text, at: 0))
        #expect(first.firstLineHeadIndent == first.headIndent)
        #expect(first.headIndent >= SelectableText.markerColumn + SelectableText.markerGap)
        #expect(first.paragraphSpacing == SelectableText.itemSpacing)
        #expect(run.markers[0].trailing == first.headIndent - SelectableText.markerGap)
        // The nested item starts past its parent's text start, its marker in between.
        let nested = try #require(paragraph(run.text, at: 13))
        #expect(nested.headIndent > first.headIndent)
        #expect(run.markers[2].trailing > first.headIndent)
    }

    @Test func aNumberedListCountsFromItsStart() {
        let run = run("3. three\n4. four")
        #expect(run.text.string == "three\nfour")
        #expect(run.markers.map { $0.text.string } == ["3.", "4."])
    }

    @Test func aQuoteIsIndentedGreyAndReportsItsRange() throws {
        let (text, quotes) = string("Before\n\n> quoted words")
        #expect(text.string == "Before\nquoted words")
        let range = try #require(quotes.first)
        #expect((text.string as NSString).substring(with: range) == "quoted words")
        #expect(paragraph(text, at: range.location)?.headIndent == SelectableText.quoteIndent)
        let color = text.attribute(.foregroundColor, at: range.location, effectiveRange: nil) as? UIColor
        #expect(color == UIColor(Palette.sub))
    }

    @Test func inlineRunsKeepTheirLook() throws {
        let (text, _) = string("plain **bold** *italic* `code` [link](https://example.com)")
        let ns = text.string as NSString
        let bold = try #require(font(text, at: ns.range(of: "bold").location))
        #expect(bold.fontDescriptor.symbolicTraits.contains(.traitBold))
        let italic = try #require(font(text, at: ns.range(of: "italic").location))
        #expect(italic.fontDescriptor.symbolicTraits.contains(.traitItalic))
        let code = ns.range(of: "code").location
        #expect(font(text, at: code)?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true)
        #expect(text.attribute(.backgroundColor, at: code, effectiveRange: nil) != nil)
        let link = ns.range(of: "link").location
        #expect((text.attribute(.link, at: link, effectiveRange: nil) as? URL)?.absoluteString == "https://example.com")
        #expect(text.attribute(.foregroundColor, at: link, effectiveRange: nil) as? UIColor == UIColor(Palette.primaryText))
    }

    @Test func codeTablesAndImagesSplitTheText() {
        let source = "Intro\n\n```\nlet x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![cat](https://example.com/cat.png)\n\nOutro"
        let segments = SelectableText.segments(MarkdownParser.parse(source), style: style)
        let kinds = segments.map { segment -> String in
            switch segment {
            case .text(let run): return "text:\(run.text.string)"
            case .code(let text): return "code:\(SelectableText.copied(text.string))"
            case .block(_, let block):
                if case .table = block { return "table" }
                if case .image = block { return "image" }
                return "other"
            }
        }
        #expect(kinds == ["text:Intro", "code:let x = 1", "table", "image", "text:Outro"])
    }

    @Test func theGuardiansMessageIsPlainText() {
        let text = SelectableText.plain("**not bold**\nnext", style: SelectableTextStyle(color: .white))
        #expect(text.string == "**not bold**\u{2028}next")
        #expect(text.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor == .white)
    }

    @Test func copyWritesPlainText() {
        #expect(SelectableText.copied("one\u{2028}two") == "one\ntwo")
    }

    @Test func aCodeBlockKeepsItsLinesInOneParagraph() {
        let segments = SelectableText.segments(MarkdownParser.parse("```\na\nb\n```"), style: style)
        guard case .code(let text) = segments.first else { Issue.record("no code"); return }
        #expect(text.string == "a\u{2028}b")
    }

    // MARK: Heights

    /// The SwiftUI drawing's height and the select mode's, at a bubble's text width.
    private func heights(_ source: String, width: CGFloat = 300, size: DynamicTypeSize = .large) -> (normal: CGFloat, selecting: CGFloat) {
        func height(_ view: some View) -> CGFloat {
            UIHostingController(rootView: view.frame(width: width).environment(\.dynamicTypeSize, size)).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
        }
        return (height(MarkdownText(source: source).fixedSize(horizontal: false, vertical: true)),
                height(MarkdownText(source: source, selectable: true).fixedSize(horizontal: false, vertical: true)))
    }

    @Test(arguments: [
        "A short reply.",
        "A reply long enough to wrap onto a few lines in a bubble, so the line spacing between them counts as much as the font does.",
        "First paragraph of the reply.\n\nSecond paragraph, which wraps onto another line in the bubble at this width.",
        "## Heading\n\nBody text under it.",
        "Body text first.\n\n### A heading lower down\n\nMore body text.",
        "Steps:\n\n1. Open the app\n2. Pick a chat that has a long name which wraps\n3. Send",
        "- one\n- two\n  - nested item\n- three",
        "> A quoted line that runs long enough to wrap at the bubble's width.\n\nAfter it.",
        "Mixed **bold**, *italic*, `code` and a [link](https://example.com).",
        "今天的天气很好，适合出去走走。下午三点以后可能有雨，记得带伞。",
        "Run this:\n\n```\nlet x = 1\nlet y = 2\n```\n\nThen check.",
        "Here are the numbers:\n\n| Day | Rain |\n|---|---|\n| Mon | 2 mm |\n\nThat is all.",
    ])
    func selectModeKeepsTheHeight(source: String) {
        let measured = heights(source)
        let difference = measured.selecting - measured.normal
        print("select-text height \(String(format: "%.2f", measured.normal)) → \(String(format: "%.2f", measured.selecting)) (\(String(format: "%+.2f", difference))): \(source.prefix(30))")
        #expect(abs(difference) <= 0.5)
    }

    /// The hugged size both ways, at a width the bubble offers: its text
    /// takes only as much width as its lines need.
    private func hugged(_ source: String, width: CGFloat, scale: CGFloat) -> (normal: CGSize, selecting: CGSize) {
        func size(_ view: some View) -> CGSize {
            UIHostingController(rootView: view.environment(\.displayScale, scale)).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        }
        return (size(MarkdownText(source: source).fixedSize(horizontal: false, vertical: true)),
                size(MarkdownText(source: source, selectable: true).fixedSize(horizontal: false, vertical: true)))
    }

    /// The bubble hugs its text, so the width it takes and where its lines
    /// break must not change either, at every width a bubble may offer.
    @Test(arguments: [
        "出版社回信了，说书稿下周一前可以看。",
        "今天的摘要：三封邮件，一个日程。",
        // The long-chat demo's numbered digest: each item a CJK line past its number.
        (1...12).map { "\($0). 今天的邮件摘要第 \($0) 条：项目进度、会议时间和需要你回复的事项。" }.joined(separator: "\n"),
        "今天的天气很好，适合出去走走。下午三点以后可能有雨，记得带伞。",
        "降噪耳机降到 ¥899 了，价格追踪想给你发提醒邮件，需要你批准。",
        "A reply long enough to wrap onto a few lines in a bubble, so the line spacing counts.",
        "Mixed **bold**, *italic*, `code` and a [link](https://example.com) in one line that wraps.",
        "- one item that wraps at narrow widths\n- 第二项也会换行，看看中文",
        "> A quoted line that runs long enough to wrap at most widths.",
        "1. Book the flight\n2. Pick a hotel near the station\n   - with breakfast\n   - 安静的房间，最好朝南\n10. Pack",
    ])
    func selectModeKeepsTheWidthAndLineBreaks(source: String) {
        var worst: (width: CGFloat, scale: CGFloat, normal: CGSize, selecting: CGSize)?
        // A phone has 3 pixels a point, an iPad and a Mac 2.
        for scale: CGFloat in [2, 3] {
            for width in stride(from: CGFloat(180), through: 340, by: 1) where worst == nil {
                let measured = hugged(source, width: width, scale: scale)
                let off = max(abs(measured.normal.width - measured.selecting.width), abs(measured.normal.height - measured.selecting.height))
                if off > 0.5 { worst = (width, scale, measured.normal, measured.selecting) }
            }
        }
        if let worst {
            print("select-text width at \(worst.width)@\(worst.scale)x: \(worst.normal) → \(worst.selecting): \(source.prefix(20))")
        }
        #expect(worst == nil)
    }

    /// The guardian's own bubble: plain `Text`, white on coral.
    @Test(arguments: ["海口明天怎么样？我想周末过去玩两天，帮我看看天气。", "Can you check whether the flight on Friday still has window seats left?"])
    func theOwnBubbleKeepsItsWidthAndLineBreaks(text: String) {
        for width in stride(from: CGFloat(180), through: 330, by: 1) {
            func size(_ view: some View) -> CGSize {
                UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
            }
            let normal = size(Text(text).romeFont(16).lineSpacing(5).fixedSize(horizontal: false, vertical: true))
            let selecting = size(SelectableTextView(text: SelectableText.plain(text, style: SelectableTextStyle(color: .white))).fixedSize(horizontal: false, vertical: true))
            guard abs(normal.width - selecting.width) <= 0.5, abs(normal.height - selecting.height) <= 0.5 else {
                Issue.record("at \(width): \(normal) → \(selecting)")
                return
            }
        }
    }

    @Test func selectModeKeepsTheHeightAtLargeText() {
        let source = "A reply that wraps at the largest text sizes.\n\n- an item\n- another item that wraps"
        for size in [DynamicTypeSize.xSmall, .xxxLarge, .accessibility3] {
            let measured = heights(source, size: size)
            print("select-text height at \(size) \(measured.normal) → \(measured.selecting)")
            #expect(abs(measured.selecting - measured.normal) <= 0.5)
        }
    }
}

/// The paragraph select mode opens on.
@MainActor
@Suite struct SelectionStartTests {
    let style = SelectableTextStyle(color: .black)

    private func paragraph(_ text: String, at index: Int) -> String {
        (text as NSString).substring(with: SelectableText.paragraph(in: text, at: index))
    }

    private func run(_ source: String) -> String {
        SelectableText.attributed(MarkdownParser.parse(source), style: style).text.string
    }

    @Test func aPressInAParagraphTakesThatParagraph() {
        let text = run("第一段：出版社回信了。书稿下周一前可以看。\n\nSecond paragraph. It has two sentences.\n\n第三段。")
        #expect(paragraph(text, at: 3) == "第一段：出版社回信了。书稿下周一前可以看。")
        let second = (text as NSString).range(of: "two").location
        #expect(paragraph(text, at: second) == "Second paragraph. It has two sentences.")
        #expect(paragraph(text, at: text.utf16.count - 1) == "第三段。")
    }

    @Test func aListItemIsAParagraph() {
        let text = run("Steps:\n\n1. Open the app\n2. 选一个聊天\n   - nested item\n3. Send")
        let second = (text as NSString).range(of: "聊天").location
        #expect(paragraph(text, at: second) == "选一个聊天")
        let nested = (text as NSString).range(of: "nested").location
        #expect(paragraph(text, at: nested) == "nested item")
        #expect(paragraph(text, at: 0) == "Steps:")
    }

    @Test func aLineBreakInsideAParagraphStaysInIt() {
        let text = run("First line\nsecond line\n\nNext")
        #expect(paragraph(text, at: 15) == "First line\u{2028}second line")
    }

    @Test func aPressOnABreakTakesTheNearestParagraph() {
        let text = run("Before.\n\nAfter.")
        let gap = (text as NSString).range(of: "\n").location
        #expect(paragraph(text, at: gap) == "Before.")
        // The guardian's own text: a blank line between two runs.
        let own = SelectableText.plain("One\n\nTwo", style: style).string
        let blank = (own as NSString).range(of: "\u{2028}").location
        #expect(paragraph(own, at: blank) == "One")
        #expect(paragraph(own, at: own.utf16.count - 1) == "Two")
    }

    @Test func aOneParagraphMessageIsAllOfIt() {
        let text = run("出版社回信了，说书稿下周一前可以看。")
        #expect(SelectableText.paragraph(in: text, at: 5) == NSRange(location: 0, length: text.utf16.count))
    }

    @Test func selectTextTakesTheLastPressAndForgetsAStaleOne() {
        let selection = TextSelection()
        let now = Date()
        selection.touchedDown(at: CGPoint(x: 10, y: 20), now: now)
        selection.begin(row: "m1", text: "Hello", now: now.addingTimeInterval(2))
        #expect(selection.target?.point == CGPoint(x: 10, y: 20))
        // Picked long after (VoiceOver, say): no press to go by.
        selection.begin(row: "m1", text: "Hello", now: now.addingTimeInterval(TextSelection.touchLifetime + 1))
        #expect(selection.target?.point == nil)
    }
}

/// Review round: a press that misses the text, the fold, task chips.
@MainActor
@Suite(.serialized) struct SelectModeEdgeTests {
    @Test func aPressThatMissesTheTextStillOpensASelection() {
        // Above the first text (a quote, the padding) and below the last.
        #expect(SelectionStart.claims(-30, top: 0, bottom: 100, first: true, last: true))
        #expect(SelectionStart.claims(140, top: 0, bottom: 100, first: true, last: true))
        // Between two texts, each takes its half of the gap.
        #expect(SelectionStart.claims(104, top: 0, bottom: 100, first: true, last: false))
        #expect(!SelectionStart.claims(106, top: 0, bottom: 100, first: true, last: false))
        #expect(SelectionStart.claims(-4, top: 0, bottom: 100, first: false, last: true))
        #expect(!SelectionStart.claims(-6, top: 0, bottom: 100, first: false, last: true))
    }

    @Test func aSelectionStopsAtTheFold() async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 600)
        window.isHidden = false
        defer { window.isHidden = true }
        // No start yet as it joins the window, so it opens no selection itself.
        let view = SelectingTextView(wraps: true)
        let text = (1...12).map { "Line \($0) of a reply that is folded." }.joined(separator: "\n\n")
        view.attributedText = SelectableText.attributed(MarkdownParser.parse(text), style: SelectableTextStyle(color: .black)).text
        let size = view.fittingSize(width: 300, scale: 2)
        view.frame = CGRect(origin: .zero, size: size)
        window.addSubview(view)
        view.start = SelectionStart(point: nil, first: true, foldBottom: 120)
        view.layoutIfNeeded()
        view.selectedRange = NSRange(location: 0, length: view.textStorage.length)
        view.selectionDidChange()
        let selected = try #require(view.selectedTextRange)
        let end = view.caretRect(for: selected.end)
        #expect(view.selectedRange.length > 0)
        #expect(view.selectedRange.length < view.textStorage.length)
        #expect(end.minY < 120)
    }

    @Test func aTaskChipKeepsItsMarkAndCopiesWithoutIt() throws {
        let info = TaskLinkInfo(id: "c", name: "Fix login", status: "ended", endReason: "done")
        let mark = SelectableText.chipMark(info, size: 13)
        #expect(mark.bounds.width > 8)
        #expect(SelectableText.copied("See \u{00A0}\u{FFFC}\u{00A0}Fix login\u{00A0}") == "See \u{00A0}\u{00A0}Fix login\u{00A0}")
        // Drawn clear in select mode, in the same place.
        let text = NSMutableAttributedString(string: "\u{FFFC}")
        text.addAttribute(.attachment, value: mark, range: NSRange(location: 0, length: 1))
        let clear = try #require(SelectableText.invisible(text).attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment)
        #expect(clear.bounds == mark.bounds)
    }
}

/// Which message is in select mode, and what ends it.
@MainActor
@Suite struct TextSelectionTests {
    @Test func selectTextPutsOneMessageInSelectMode() {
        let selection = TextSelection()
        #expect(!selection.isActive)
        selection.begin(row: "m1", text: "Hello")
        #expect(selection.isSelecting(row: "m1", text: "Hello"))
        #expect(!selection.isSelecting(row: "m2", text: "Hello"))
        #expect(!selection.isSelecting(row: nil, text: "Hello"))
    }

    @Test func selectTextOnAnotherMessageMovesIt() {
        let selection = TextSelection()
        selection.begin(row: "m1", text: "Hello")
        selection.begin(row: "m2", text: "Bye")
        #expect(!selection.isSelecting(row: "m1", text: "Hello"))
        #expect(selection.isSelecting(row: "m2", text: "Bye"))
    }

    @Test func endLeavesSelectMode() {
        let selection = TextSelection()
        selection.begin(row: "m1", text: "Hello")
        selection.end()
        #expect(!selection.isActive)
    }

    @Test func aMessageThatChangesLeavesSelectMode() {
        let selection = TextSelection()
        selection.begin(row: "m1", text: "Hello")
        // Drawn with its new text, it is no longer selecting at once.
        #expect(!selection.isSelecting(row: "m1", text: "Hello, world"))
        // Another message changing leaves it be.
        selection.messageChanged(row: "m2", text: "Other")
        #expect(selection.isActive)
        selection.messageChanged(row: "m1", text: "Hello")
        #expect(selection.isActive)
        selection.messageChanged(row: "m1", text: "Hello, world")
        #expect(!selection.isActive)
    }

    @Test func theComposerTakingFocusLeavesSelectMode() {
        let selection = TextSelection()
        selection.begin(row: "m1", text: "Hello")
        NotificationCenter.default.post(name: UITextView.textDidBeginEditingNotification, object: UITextView())
        #expect(!selection.isActive)
    }
}


/// What select mode draws: the text on screen is the same before, during and
/// after it, line by line, so nothing moves as it starts or ends.
@MainActor
@Suite(.serialized) struct SelectModeDrawingTests {
    /// Each text line's dark ink, as its centre (x, y) in pixels.
    static func lines(_ image: UIImage) -> [CGPoint] {
        let cg = image.cgImage!
        let w = cg.width, h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let context = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        func ink(_ x: Int, _ y: Int) -> Double {
            let i = (y * w + x) * 4
            let sum = Int(data[i]) + Int(data[i + 1]) + Int(data[i + 2])
            return sum < 300 ? Double(300 - sum) : 0
        }
        var result: [CGPoint] = []
        var sx = 0.0, sy = 0.0, total = 0.0
        for y in 0..<h {
            var row = 0.0
            for x in 0..<w {
                let value = ink(x, y)
                guard value > 0 else { continue }
                row += value; sx += Double(x) * value; sy += Double(y) * value
            }
            total += row
            if row == 0, total > 0 {
                result.append(CGPoint(x: sx / total, y: sy / total))
                sx = 0; sy = 0; total = 0
            }
        }
        return result
    }

    private func render(_ view: some View) async throws -> UIImage {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let size = CGSize(width: 300, height: 260)
        let host = UIHostingController(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading).background(Color.white))
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .light
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.isHidden = false
        try await Task.sleep(for: .milliseconds(400))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return image
    }

    @Test(arguments: [
        "出版社回信了，说书稿下周一前可以看。",
        "First paragraph of the reply, long enough to wrap here.\n\n第二段：今天的摘要，三封邮件。",
        "1. 今天的邮件摘要第 1 条：项目进度、会议时间和需要你回复的事项。\n2. 第二条，短一点。",
        "> A quoted line that wraps at this width, then **bold** and `code`.",
    ])
    func everyLineStaysWhereItIs(source: String) async throws {
        let normal = Self.lines(try await render(MarkdownText(source: source, color: .black).fixedSize(horizontal: false, vertical: true)))
        SelectingTextView.opensSelection = false
        defer { SelectingTextView.opensSelection = true }
        let selecting = Self.lines(try await render(MarkdownText(source: source, color: .black, selectable: true).fixedSize(horizontal: false, vertical: true)))
        #expect(normal.count == selecting.count)
        for (a, b) in zip(normal, selecting) {
            #expect(abs(a.x - b.x) < 0.01 && abs(a.y - b.y) < 0.01, "line moved from \(a) to \(b)")
        }
    }
}
