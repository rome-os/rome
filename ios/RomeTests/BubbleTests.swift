import Testing
@testable import Rome

@Suite struct BubbleFoldTests {
    @Test func aShortReplyDoesNotFold() {
        #expect(!AgentBubble.folds("Got it."))
        #expect(!AgentBubble.folds(Array(repeating: "line", count: 15).joined(separator: "\n")))
    }

    @Test func aLongReplyFoldsInItsBubble() {
        #expect(AgentBubble.folds(Array(repeating: "line", count: 16).joined(separator: "\n")))
        // A few long paragraphs wrap past fifteen lines too.
        #expect(AgentBubble.folds(Array(repeating: String(repeating: "word ", count: 40), count: 3).joined(separator: "\n")))
    }
}
