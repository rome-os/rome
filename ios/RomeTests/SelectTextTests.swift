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
    private func hugged(_ source: String, width: CGFloat) -> (normal: CGSize, selecting: CGSize) {
        func size(_ view: some View) -> CGSize {
            UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        }
        return (size(MarkdownText(source: source).fixedSize(horizontal: false, vertical: true)),
                size(MarkdownText(source: source, selectable: true).fixedSize(horizontal: false, vertical: true)))
    }

    /// The bubble hugs its text, so the width it takes and where its lines
    /// break must not change either, at every width a bubble may offer.
    @Test(arguments: [
        "出版社回信了，说书稿下周一前可以看。",
        "今天的摘要：三封邮件，一个日程。",
        "今天的天气很好，适合出去走走。下午三点以后可能有雨，记得带伞。",
        "降噪耳机降到 ¥899 了，价格追踪想给你发提醒邮件，需要你批准。",
        "A reply long enough to wrap onto a few lines in a bubble, so the line spacing counts.",
        "Mixed **bold**, *italic*, `code` and a [link](https://example.com) in one line that wraps.",
        "- one item that wraps at narrow widths\n- 第二项也会换行，看看中文",
        "> A quoted line that runs long enough to wrap at most widths.",
        "1. Book the flight\n2. Pick a hotel near the station\n   - with breakfast\n   - 安静的房间，最好朝南\n10. Pack",
    ])
    func selectModeKeepsTheWidthAndLineBreaks(source: String) {
        var worst: (width: CGFloat, normal: CGSize, selecting: CGSize)?
        for width in stride(from: CGFloat(180), through: 340, by: 1) {
            let measured = hugged(source, width: width)
            let off = max(abs(measured.normal.width - measured.selecting.width), abs(measured.normal.height - measured.selecting.height))
            if off > 0.5, worst == nil { worst = (width, measured.normal, measured.selecting) }
        }
        if let worst {
            print("select-text width at \(worst.width): \(worst.normal) → \(worst.selecting): \(source.prefix(20))")
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

