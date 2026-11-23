import XCTest

/// The drawer's topic chat rows: swipe right to pin, no swipe to the left,
/// press and hold for Rename, Pin, Archive and Delete, on the demo data. The
/// drawer still closes from the page beside it. Each check keeps a screenshot.
final class DrawerSwipeTests: XCTestCase {
    /// A demo topic chat with no unread replies, so its pin shows.
    private let topic = "读书笔记"

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication.forUITests()
        app.launchEnvironment["ROME_DEMO"] = "1"
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        return app
    }

    /// Opens the drawer from the header on a phone; a wide window has it
    /// beside the page already. The hidden pages keep their own header
    /// buttons in the tree, so only a visible one is pressed.
    @MainActor
    private func openDrawer(_ app: XCUIApplication) {
        let row = self.row(app, topic)
        if row.waitForExistence(timeout: 3), onScreen(app, row), row.isHittable { return }
        let button = app.buttons.matching(identifier: "Open navigation").allElementsBoundByIndex
            .first { $0.isHittable && $0.frame.width <= 60 }
            ?? app.buttons["Open navigation"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        waitOnScreen(app, row)
        waitFor("isHittable == true", row)
    }

    @MainActor
    private func row(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(identifier: "topic-chat").matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    @MainActor
    private func firstRow(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "topic-chat").element(boundBy: 0)
    }

    @MainActor
    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
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
    private func waitFor(_ format: String, _ element: XCUIElement, timeout: TimeInterval = 5) {
        expectation(for: NSPredicate(format: format), evaluatedWith: element)
        waitForExpectations(timeout: timeout)
    }

    @MainActor
    func testSwipeRightPinsAndUnpins() {
        let app = launch()
        openDrawer(app)
        let row = row(app, topic)
        // A short swipe stops at Pin.
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.5)))
        let pin = app.buttons["Pin"].firstMatch
        XCTAssertTrue(pin.waitForExistence(timeout: 3))
        keep("swipe-right-pin")
        pin.tap()
        expectation(for: NSPredicate(format: "label == %@ AND value CONTAINS %@", topic, "Pinned"), evaluatedWith: firstRow(app))
        waitForExpectations(timeout: 5)
        keep("pinned-on-top")
        // The drawer stayed open. The row is still sliding to the top.
        waitOnScreen(app, row)
        waitFor("isHittable == true", row)

        // A full swipe takes the action at once. A drag across the whole row
        // is a full swipe every time; a quick flick sometimes only opens the
        // button.
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 1.0, dy: 0.5)))
        expectation(for: NSPredicate(format: "NOT (value CONTAINS %@)", "Pinned"), evaluatedWith: self.row(app, topic))
        waitForExpectations(timeout: 5)
    }

    /// A swipe to the left shows no buttons: Archive and Delete were too
    /// easy to set off there.
    @MainActor
    func testSwipeLeftOffersNothing() {
        let app = launch()
        openDrawer(app)
        let row = row(app, topic)
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5)))
        XCTAssertFalse(app.buttons["Archive"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["Delete"].exists)
    }

    @MainActor
    func testPressAndHoldOffersRenamePinArchiveAndDelete() {
        let app = launch()
        openDrawer(app)
        let row = row(app, topic)
        row.press(forDuration: 1.2)
        let pin = app.buttons["Pin"].firstMatch
        XCTAssertTrue(pin.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Rename"].exists)
        XCTAssertTrue(app.buttons["Archive"].exists)
        XCTAssertTrue(app.buttons["Delete"].exists)
        keep("press-and-hold-menu")
        pin.tap()
        expectation(for: NSPredicate(format: "label == %@ AND value CONTAINS %@", topic, "Pinned"), evaluatedWith: firstRow(app))
        waitForExpectations(timeout: 5)
    }

    /// Rename asks for the name, with the current one filled in, and the
    /// row shows the new one.
    @MainActor
    func testRenameFromTheMenu() {
        let app = launch()
        openDrawer(app)
        row(app, topic).press(forDuration: 1.2)
        let rename = app.buttons["Rename"].firstMatch
        XCTAssertTrue(rename.waitForExistence(timeout: 3))
        rename.tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        let field = alert.textFields.firstMatch
        XCTAssertEqual(field.value as? String, topic)
        field.tap()
        field.typeText(" 2")
        keep("rename-asks")
        alert.buttons["Rename"].tap()
        XCTAssertTrue(self.row(app, "\(topic) 2").waitForExistence(timeout: 5))
    }

    /// Delete from the menu always asks; Archive goes ahead at once for a
    /// chat with nothing to move.
    @MainActor
    func testDeleteFromTheMenuAsksAndArchiveDoesNot() {
        let app = launch()
        openDrawer(app)
        let row = row(app, topic)
        row.press(forDuration: 1.2)
        let delete = app.buttons["Delete"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 3))
        delete.tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.label.contains(topic))
        keep("delete-asks")
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 3))

        row.press(forDuration: 1.2)
        let archive = app.buttons["Archive"].firstMatch
        XCTAssertTrue(archive.waitForExistence(timeout: 3))
        archive.tap()
        waitFor("exists == false", row)
    }

    /// A phone's drawer closes with a swipe to the left on the page beside it, as before.
    @MainActor
    func testTheDrawerStillClosesFromThePage() throws {
        let app = launch()
        let row = row(app, topic)
        if row.waitForExistence(timeout: 3), row.isHittable {
            throw XCTSkip("A wide window keeps the drawer beside the page.")
        }
        openDrawer(app)
        let window = app.windows.firstMatch
        let page = window.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5))
        page.press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)))
        waitFor("isHittable == false", row)
    }
}
