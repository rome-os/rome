import XCTest

final class ThreadFocusUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor
    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    @MainActor
    func testQuoteOpensAndCloseRestoresTheMountedChat() {
        let app = XCUIApplication()
        app.launchEnvironment["ROME_DEMO"] = "1"
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        let quotes = app.buttons.matching(identifier: "reply-quote")
        var quote: XCUIElement?
        for _ in 0..<8 {
            quote = quotes.allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > 150 && $0.frame.maxY < 650 }
            if quote != nil { break }
            app.swipeDown()
        }
        guard let quote else { XCTFail("No visible demo quote"); return }
        keep("reply-chain-before")
        quote.tap()
        let close = app.buttons["close-reply-chain"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        keep("reply-chain-open")
        XCTAssertFalse(app.buttons.matching(identifier: "reply-quote").allElementsBoundByIndex.contains { $0.isHittable })
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(quote.isHittable)
        keep("reply-chain-closed")
    }

    /// A dev stack seeded by seed-chains.mjs, never a real account or model.
    @MainActor
    func testSeededBackendKeepsPressedBubbleAtSameY() throws {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["ROME_RCF_ORIGIN"], let user = env["ROME_RCF_USER"], let password = env["ROME_RCF_PASSWORD"] else {
            throw XCTSkip("Set ROME_RCF_ORIGIN/USER/PASSWORD for the seeded dev stack")
        }
        let app = XCUIApplication()
        app.launchEnvironment["ROME_LOCAL_ORIGIN"] = origin
        app.launchEnvironment["ROME_LOCAL_USER"] = user
        app.launchEnvironment["ROME_LOCAL_PASSWORD"] = password
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        let target = app.staticTexts["Add both flights to my calendar."].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 30))
        let y = target.frame.minY
        let quote = app.buttons.matching(identifier: "reply-quote").allElementsBoundByIndex
            .min { abs($0.frame.maxY - y) < abs($1.frame.maxY - y) }
        XCTAssertNotNil(quote)
        keep("seeded-reply-chain-before")
        quote?.tap()
        let close = app.buttons["close-reply-chain"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        sleep(1)
        print("RCF seeded anchor y before=\(y) focused=\(target.frame.minY)")
        XCTAssertEqual(target.frame.minY, y, accuracy: 1)
        keep("seeded-reply-chain-open")
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        waitForExpectations(timeout: 5)
        sleep(1)
        print("RCF seeded anchor y closed=\(target.frame.minY)")
        XCTAssertEqual(target.frame.minY, y, accuracy: 1)
        keep("seeded-reply-chain-closed")
    }
}
