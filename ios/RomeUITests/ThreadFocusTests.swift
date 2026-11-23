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
        XCTAssertFalse(app.buttons["transcript-back-to-bottom"].exists)
        keep("reply-chain-open")
        XCTAssertFalse(app.buttons.matching(identifier: "reply-quote").allElementsBoundByIndex.contains { $0.isHittable })
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(quote.isHittable)
        keep("reply-chain-closed")
        XCTAssertTrue(app.textViews["Message"].exists)
        let main = app.otherElements["main-transcript-content"]
        let bottom = app.buttons["transcript-back-to-bottom"]
        for _ in 0..<4 {
            if bottom.exists { break }
            main.swipeDown()
        }
        XCTAssertTrue(bottom.waitForExistence(timeout: 3), "Ordinary main-screen control still works outside focus")
        XCTAssertEqual(app.buttons.matching(identifier: "transcript-back-to-bottom").count, 1)
        bottom.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: bottom)
        waitForExpectations(timeout: 5)
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
        try nativeFrames(text: "Add both flights to my calendar.", id: "5eedc4a1-0000-4000-8000-000000000047:1", name: "native-motion")
    }

    @MainActor
    func testSeededShortNativeOpenCloseFrames() throws {
        try nativeFrames(text: "第二天的龙安寺需要预约吗？", id: "5eedc4a1-0000-4000-8000-000000000029:1", name: "short-motion", find: true)
    }

    @MainActor
    private func nativeFrames(text: String, id: String, name: String, find: Bool = false) throws {
        let app = try seededApp()
        let main = app.otherElements["main-transcript-content"]
        XCTAssertTrue(main.waitForExistence(timeout: 30))
        let target = main.descendants(matching: .any).matching(identifier: "shared-content/\(id)").firstMatch.staticTexts[text].firstMatch
        if find {
            for _ in 0..<6 {
                if target.exists && target.isHittable && target.frame.minY > 150 && target.frame.maxY < 650 { break }
                main.swipeDown()
            }
        }
        XCTAssertTrue(target.waitForExistence(timeout: 30))
        let quote = main.descendants(matching: .any).matching(identifier: "shared-content/\(id)").firstMatch.descendants(matching: .any).matching(identifier: "reply-quote").firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 5))
        XCTAssertTrue(quote.isHittable && target.isHittable, "Use the actually visible main bubble, not a retained offscreen row")
        let y = target.frame.minY
        keep("\(name)-before")
        quote.tap()
        let close = app.buttons["close-reply-chain"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        let focused = app.collectionViews["reply-chain-transcript"]
        XCTAssertTrue(focused.waitForExistence(timeout: 5))
        let focusedTarget = app.otherElements["reply-chain-content"].descendants(matching: .any).matching(identifier: "shared-content/\(id)").firstMatch.staticTexts[text].firstMatch
        XCTAssertTrue(focusedTarget.waitForExistence(timeout: 5) && focusedTarget.isHittable)
        XCTAssertEqual(focusedTarget.frame.minY, y, accuracy: 1)
        XCTAssertTrue(app.textViews["Message in thread"].exists)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        XCTAssertFalse(app.buttons["transcript-back-to-bottom"].exists)
        XCTAssertFalse(app.buttons["Retry"].exists)
        print("RCF actual \(name) before=\(y) focused=\(focusedTarget.frame.minY)")
        keep("\(name)-open")
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(main.waitForExistence(timeout: 5), "The actual main content scope is restored after the asynchronous inverse")
        XCTAssertTrue(target.isHittable)
        XCTAssertEqual(target.frame.minY, y, accuracy: 1)
        XCTAssertTrue(app.textViews["Message"].exists)
        print("RCF actual \(name) closed=\(target.frame.minY)")
        keep("\(name)-closed")
    }

    /// A dev stack seeded by seed-chains.mjs, never a real account or model.
    @MainActor
    func testSeededBackendKeepsPressedBubbleAtSameY() async throws {
        let app = try seededApp()
        let target = app.staticTexts["Add both flights to my calendar."].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 30))
        let y = target.frame.minY
        let quote = app.otherElements["main-transcript-content"].descendants(matching: .any).matching(identifier: "shared-content/5eedc4a1-0000-4000-8000-000000000047:1").firstMatch.descendants(matching: .any).matching(identifier: "reply-quote").firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 5))
        keep("seeded-reply-chain-before")
        quote.tap()
        let close = app.buttons["close-reply-chain"]
        XCTAssertTrue(close.waitForExistence(timeout: 2))
        XCTAssertTrue(app.textViews["Message in thread"].exists)
        XCTAssertFalse(app.buttons["Cancel reply"].exists)
        let focusedTarget = app.otherElements["reply-chain-content"].staticTexts["Add both flights to my calendar."].firstMatch
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
        XCTAssertTrue(app.otherElements["main-transcript-content"].waitForExistence(timeout: 5))
        // UIKit can expose the same quote as either Button or PopUpButton.
        XCTAssertTrue(quote.waitForExistence(timeout: 5) && quote.isHittable)
        quote.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 2))
        let focused = app.collectionViews["reply-chain-transcript"]
        let selected = app.otherElements["reply-chain-content"].staticTexts["Add both flights to my calendar."].firstMatch
        XCTAssertTrue(selected.waitForExistence(timeout: 5))
        let live = app.otherElements["reply-chain-content"]
        let beforeDrag = selected.frame.minY
        // Drag toward the older rows, not past the padded newest edge.
        live.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.70)).press(forDuration: 0.1,
            thenDragTo: live.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.76)),
            withVelocity: .slow, thenHoldForDuration: 0.4)
        XCTAssertGreaterThan(abs(selected.frame.minY - beforeDrag), 20, "The real pointer scrolls the focused native collection through the live content surface")
        keep("seeded-reply-chain-native-pan")
        selected.press(forDuration: 1)
        let reply = app.buttons["Reply"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 3))
        reply.tap()
        let cancel = app.buttons["Cancel reply"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 3))
        let input = app.textViews["Message in thread"]
        let previousDraft = input.value as? String ?? ""
        let expectedDraft = (previousDraft == "Message in thread" ? "" : previousDraft) + "Unsent thread draft"
        input.typeText("Unsent thread draft")
        cancel.tap()
        XCTAssertTrue(close.exists && focused.exists, "Cancel an explicit reply, not the thread")
        XCTAssertFalse(cancel.exists)
        XCTAssertEqual(input.value as? String, expectedDraft)
        keep("seeded-reply-chain-manual-cancel")
        close.tap()
        XCTAssertTrue(app.textViews["Message"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.textViews["Message"].value as? String, expectedDraft)
    }
}
