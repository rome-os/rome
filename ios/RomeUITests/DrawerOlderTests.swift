import XCTest

final class DrawerOlderTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor
    private func openDrawer(_ app: XCUIApplication) {
        let header = app.buttons["older-topic-chats-header"].firstMatch
        if header.exists && onScreen(app, header) && header.isHittable { return }
        let button = app.buttons.matching(identifier: "Open navigation").allElementsBoundByIndex
            .first { $0.isHittable && $0.frame.width <= 60 }
            ?? app.buttons["Open navigation"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        waitOnScreen(app, header)
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: header)
        waitForExpectations(timeout: 5)
    }

    /// The element is drawn inside the window, not slid away with the drawer.
    @MainActor
    private func onScreen(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        element.exists && app.windows.firstMatch.frame.contains(CGPoint(x: element.frame.midX, y: element.frame.midY))
    }

    /// Waits up to `timeout` for the element to come on screen. Asked while
    /// the element is still off screen, as a row is while the drawer slides
    /// in or moves to its new place, `isHittable` fails the test instead of
    /// answering false, so it is asked only once this returns.
    @MainActor
    private func waitOnScreen(_ app: XCUIApplication, _ element: XCUIElement, timeout: TimeInterval = 5) {
        let deadline = Date().addingTimeInterval(timeout)
        while !onScreen(app, element), Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertTrue(onScreen(app, element), "\(element) never came on screen")
    }

    @MainActor
    private func row(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(identifier: "topic-chat").matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    @MainActor
    func testFoldingPersistenceAndOpenException() {
        let app = XCUIApplication.forUITests()
        app.launchEnvironment["ROME_DEMO"] = "older-topics"
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        openDrawer(app)
        let header = app.buttons["older-topic-chats-header"].firstMatch
        // Make the start independent of a preceding run's saved preference.
        if header.value as? String == "Expanded" { header.tap() }
        XCTAssertEqual(header.label, "Older · 3")
        XCTAssertFalse(row(app, "今天吃了什么").isHittable)
        XCTAssertTrue(row(app, "京都旅行计划").isHittable)
        XCTAssertTrue(row(app, "读书笔记").isHittable)
        header.tap()
        XCTAssertTrue(row(app, "今天吃了什么").waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        openDrawer(app)
        XCTAssertEqual(header.value as? String, "Expanded")
        row(app, "今天吃了什么").tap()
        openDrawer(app)
        XCTAssertEqual(header.label, "Older · 2")
        header.tap()
        XCTAssertEqual(header.value as? String, "Collapsed")
        XCTAssertTrue(row(app, "今天吃了什么").isHittable)
        XCTAssertFalse(row(app, "附近的咖啡馆").isHittable)
        app.terminate()
        app.launch()
        openDrawer(app)
        XCTAssertEqual(header.value as? String, "Collapsed")
    }

    /// The Archived button sits in the Topic chats header, folded or not,
    /// and opens the sheet.
    @MainActor
    func testArchivedButtonStaysInTheHeaderWhenFolded() {
        let app = XCUIApplication.forUITests()
        app.launchEnvironment["ROME_DEMO"] = "older-topics"
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        openDrawer(app)
        let archived = app.buttons["archived-topic-chats"].firstMatch
        XCTAssertTrue(archived.waitForExistence(timeout: 10))
        waitOnScreen(app, archived)
        XCTAssertEqual(archived.label, "Archived")
        let fold = app.buttons["topic-chats-header"].firstMatch
        fold.tap()
        waitOnScreen(app, archived)
        // The fold persists: unfold again for the next test.
        fold.tap()
        XCTAssertTrue(app.buttons["older-topic-chats-header"].firstMatch.waitForExistence(timeout: 5))
        archived.tap()
        XCTAssertTrue(app.buttons["archived-topic-chat"].firstMatch.waitForExistence(timeout: 5))
    }
}
