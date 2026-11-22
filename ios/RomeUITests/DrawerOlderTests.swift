import XCTest

final class DrawerOlderTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor
    private func openDrawer(_ app: XCUIApplication) {
        let header = app.buttons["older-topic-chats-header"].firstMatch
        if header.exists && header.isHittable { return }
        let button = app.buttons.matching(identifier: "Open navigation").allElementsBoundByIndex
            .first { $0.isHittable && $0.frame.width <= 60 }
            ?? app.buttons["Open navigation"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: header)
        waitForExpectations(timeout: 5)
    }

    @MainActor
    private func row(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(identifier: "topic-chat").matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    @MainActor
    func testFoldingPersistenceAndOpenException() {
        let app = XCUIApplication()
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
}
