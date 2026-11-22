import XCTest

/// Reply in the Chat, on the demo's long chat: Reply in the long-press menu
/// opens the reply bar, and the replied message stays in view above the
/// keyboard instead of the list going to the bottom. A swipe on a message
/// replies to nothing.
final class ReplyMenuTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["ROME_DEMO"] = "long-chat"
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        return app
    }

    /// A bubble of the demo's long chat whose text has `marker`, well inside
    /// the screen, up the chat, so the newest rows are out of view: going to
    /// the bottom would be seen.
    @MainActor
    private func bubble(_ app: XCUIApplication, _ marker: String) -> XCUIElement {
        let texts = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '第' AND label CONTAINS %@", marker))
        let window = app.windows.firstMatch
        XCTAssertTrue(window.staticTexts.firstMatch.waitForExistence(timeout: 20))
        let height = window.frame.height
        for _ in 0..<8 {
            window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
                .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
            sleep(1)
            for index in 0..<texts.count {
                let text = texts.element(boundBy: index)
                let frame = text.frame
                if frame.minY > height * 0.3, frame.maxY < height * 0.55 { return text }
            }
        }
        XCTFail("no \(marker) bubble mid-screen:\n\(app.debugDescription)")
        return texts.firstMatch
    }

    @MainActor
    private func swipe(_ element: XCUIElement, by dx: CGFloat) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // At a finger's pace, holding a moment before letting go.
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: dx, dy: 0)), withVelocity: 250, thenHoldForDuration: 0.3)
    }

    /// The replied message is on screen between the header and the keyboard.
    @MainActor
    private func assertInView(_ app: XCUIApplication, _ element: XCUIElement, label: String) {
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "the keyboard did not come up")
        sleep(1)
        let keyboard = app.keyboards.firstMatch.frame
        let frame = app.staticTexts[label].firstMatch.frame
        XCTAssertGreaterThan(frame.minY, 80, "the replied message went under the header")
        XCTAssertLessThan(frame.maxY, keyboard.minY, "the replied message went under the keyboard")
    }

    /// A swipe either way, on the Agent's message or the guardian's own,
    /// does not reply: Reply is in the menu only.
    @MainActor
    func testASwipeDoesNotReply() {
        let app = launch()
        let answer = bubble(app, "个回答")
        swipe(answer, by: 140)
        swipe(answer, by: -140)
        let question = bubble(app, "个问题")
        swipe(question, by: 140)
        XCTAssertFalse(app.buttons["Cancel reply"].waitForExistence(timeout: 2))
    }

    /// Reply in the long-press menu, on the guardian's own message too, keeps
    /// the message in view the same way.
    @MainActor
    func testReplyInTheMenuKeepsTheMessageInView() {
        let app = launch()
        let message = bubble(app, "个问题")
        let label = message.label
        message.press(forDuration: 1.2)
        let reply = app.buttons["Reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "no Reply in the menu")
        reply.tap()
        XCTAssertTrue(app.buttons["Cancel reply"].waitForExistence(timeout: 5), "no reply bar")
        assertInView(app, message, label: label)
    }
}
