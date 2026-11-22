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
        let focused = app.collectionViews["reply-chain-transcript"]
        XCTAssertTrue(focused.waitForExistence(timeout: 5))
        XCTAssertTrue(app.textViews["Message in thread"].exists)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        keep("reply-chain-open")
        XCTAssertFalse(app.buttons.matching(identifier: "reply-quote").allElementsBoundByIndex.contains { $0.isHittable })
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(quote.isHittable)
        keep("reply-chain-closed")
        XCTAssertTrue(app.textViews["Message"].exists)
    }

    @MainActor
    private func seededApp() throws -> XCUIApplication {
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
        return app
    }

    @MainActor
    func testSeededNativeOpenCloseFrames() throws {
        let app = try seededApp()
        let main = app.collectionViews["transcript"]
        let text = "Add both flights to my calendar."
        let target = main.staticTexts[text].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 30))
        let quote = main.cells["5eedc4a1-0000-4000-8000-000000000047:1"].buttons["reply-quote"]
        XCTAssertTrue(quote.waitForExistence(timeout: 5))
        XCTAssertTrue(quote.isHittable && target.isHittable, "Use the actually visible main bubble, not a retained offscreen row")
        let y = target.frame.minY
        keep("native-motion-before")
        quote.tap()
        let close = app.buttons["close-reply-chain"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        let focused = app.collectionViews["reply-chain-transcript"]
        let focusedTarget = focused.staticTexts[text].firstMatch
        XCTAssertTrue(focusedTarget.waitForExistence(timeout: 5) && focusedTarget.isHittable)
        XCTAssertEqual(focusedTarget.frame.minY, y, accuracy: 1)
        XCTAssertTrue(app.textViews["Message in thread"].exists)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        XCTAssertFalse(app.buttons["Retry"].exists)
        print("RCF actual native motion before=\(y) focused=\(focusedTarget.frame.minY)")
        keep("native-motion-open")
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(target.isHittable)
        XCTAssertEqual(target.frame.minY, y, accuracy: 1)
        XCTAssertTrue(app.textViews["Message"].exists)
        print("RCF actual native motion closed=\(target.frame.minY)")
        keep("native-motion-closed")
    }

    /// A dev stack seeded by seed-chains.mjs, never a real account or model.
    @MainActor
    func testSeededBackendKeepsPressedBubbleAtSameY() async throws {
        let app = try seededApp()
        let target = app.staticTexts["Add both flights to my calendar."].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 30))
        let y = target.frame.minY
        let quote = app.cells["5eedc4a1-0000-4000-8000-000000000047:1"].buttons["reply-quote"]
        XCTAssertTrue(quote.waitForExistence(timeout: 5))
        keep("seeded-reply-chain-before")
        quote.tap()
        let close = app.buttons["close-reply-chain"]
        XCTAssertTrue(close.waitForExistence(timeout: 2))
        XCTAssertTrue(app.textViews["Message in thread"].exists)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        let focusedTarget = app.collectionViews["reply-chain-transcript"].staticTexts["Add both flights to my calendar."].firstMatch
        XCTAssertTrue(focusedTarget.waitForExistence(timeout: 5))
        print("RCF seeded anchor y before=\(y) focused=\(focusedTarget.frame.minY)")
        XCTAssertEqual(focusedTarget.frame.minY, y, accuracy: 1)
        keep("seeded-reply-chain-memory")
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(focusedTarget.frame.minY, y, accuracy: 1)
        keep("seeded-reply-chain-open")
        close.tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        await fulfillment(of: [closed], timeout: 5)
        sleep(1)
        print("RCF seeded anchor y closed=\(target.frame.minY)")
        XCTAssertEqual(target.frame.minY, y, accuracy: 1)
        keep("seeded-reply-chain-closed")
        XCTAssertTrue(app.textViews["Message"].exists)
        quote.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 2))
        let focused = app.collectionViews["reply-chain-transcript"]
        let selected = focused.staticTexts["Add both flights to my calendar."].firstMatch
        XCTAssertTrue(selected.waitForExistence(timeout: 5))
        selected.press(forDuration: 1)
        let reply = app.buttons["Reply"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 3))
        reply.tap()
        let cancel = app.buttons["Cancel reply"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 3))
        let input = app.textViews["Message in thread"]
        input.typeText("Unsent thread draft")
        cancel.tap()
        XCTAssertTrue(close.exists && focused.exists, "Cancel an explicit reply, not the thread")
        XCTAssertFalse(cancel.exists)
        XCTAssertEqual(input.value as? String, "Unsent thread draft")
        keep("seeded-reply-chain-manual-cancel")
        close.tap()
        XCTAssertTrue(app.textViews["Message"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.textViews["Message"].value as? String, "Unsent thread draft")
    }
}
