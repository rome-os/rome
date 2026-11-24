import XCTest

/// A message of several photos, on the demo data: a tap on one opens the
/// viewer at that photo, not at the first.
final class PhotoViewerTests: XCTestCase {
    /// The demo topic chat whose message has three photos alone.
    private let topic = "出错的情况"

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

    /// Opens the topic chat from the drawer; a wide window has it beside the
    /// page already.
    @MainActor
    private func openTopic(_ app: XCUIApplication) {
        let row = app.buttons.matching(identifier: "topic-chat").matching(NSPredicate(format: "label == %@", topic)).firstMatch
        if !(row.waitForExistence(timeout: 3) && row.isHittable) {
            let button = app.buttons.matching(identifier: "Open navigation").allElementsBoundByIndex
                .first { $0.isHittable && $0.frame.width <= 60 }
                ?? app.buttons["Open navigation"].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 15))
            button.tap()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: row)
            wait(for: [hittable], timeout: 15)
        }
        row.tap()
    }

    @MainActor
    func testTheThirdPhotoOpensAtTheThird() {
        let app = launch()
        openTopic(app)
        // The three photos come first, then the one sent with text.
        let photos = app.descendants(matching: .any).matching(identifier: "user-photo")
        let loaded = expectation(for: NSPredicate(format: "count >= 4"), evaluatedWith: photos)
        wait(for: [loaded], timeout: 20)
        let window = app.windows.firstMatch.frame
        let shown = photos.allElementsBoundByIndex
            .filter { window.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
            .sorted { ($0.frame.minY, $0.frame.minX) < ($1.frame.minY, $1.frame.minX) }
        XCTAssertGreaterThanOrEqual(shown.count, 3, "the three photos are not on screen:\n\(app.debugDescription)")
        shown[2].tap()

        let pages = app.pageIndicators.firstMatch
        XCTAssertTrue(pages.waitForExistence(timeout: 10), "the viewer did not open:\n\(app.debugDescription)")
        XCTAssertEqual(pages.value as? String, "page 3 of 3")
    }
}
