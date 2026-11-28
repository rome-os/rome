import XCTest

/// The photo viewer on the demo data: a tap on one of several photos opens
/// the viewer at that photo, and closing it leaves the chat as it was.
final class PhotoViewerTests: XCTestCase {
    /// The demo topic chat whose message has three photos alone.
    private let topic = "出错的情况"

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication.forUITests()
        app.launchEnvironment["ROME_DEMO"] = "1"
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + arguments
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        return app
    }

    /// Opens the topic chat from the drawer; a wide window has it beside the
    /// page already.
    @MainActor
    private func openTopic(_ app: XCUIApplication, named name: String? = nil) {
        // A row's label can carry its unread count after the name.
        let row = app.buttons.matching(identifier: "topic-chat").matching(NSPredicate(format: "label BEGINSWITH %@", name ?? topic)).firstMatch
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

    /// The viewer is dark on a light app, and the Agent's bubble behind it
    /// stays light once it closes: it once came back dark until the chat
    /// was opened again.
    @MainActor
    func testClosingTheViewerLeavesTheBubblesLight() {
        let app = launch(arguments: ["-appearance", "light"])
        openTopic(app, named: "京都旅行计划")
        let picture = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "河原町酒店外观")).firstMatch
        XCTAssertTrue(picture.waitForExistence(timeout: 20), "the hotel photo is not in the chat:\n\(app.debugDescription)")
        let list = app.collectionViews["transcript"].firstMatch
        for _ in 0..<6 where !picture.isHittable { list.swipeDown() }
        XCTAssertTrue(picture.isHittable)
        // The bubble's own fill, in its padding left of the photo.
        let spot = CGPoint(x: picture.frame.minX - 6, y: picture.frame.midY)
        XCTAssertGreaterThan(brightness(at: spot), 0.6, "the bubble is not light before the viewer opens")

        picture.tap()
        let close = app.buttons["Close"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10), "the viewer did not open:\n\(app.debugDescription)")
        close.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        wait(for: [gone], timeout: 10)
        sleep(1)
        XCTAssertTrue(picture.isHittable)
        XCTAssertGreaterThan(brightness(at: CGPoint(x: picture.frame.minX - 6, y: picture.frame.midY)), 0.6, "the bubble came back dark")
    }

    /// The screen's brightness at a point, 0 (black) to 1 (white).
    @MainActor
    private func brightness(at point: CGPoint) -> CGFloat {
        let image = XCUIScreen.main.screenshot().image
        guard let cgImage = image.cgImage else { return 0 }
        let x = Int(point.x * image.scale), y = Int(point.y * image.scale)
        guard let pixel = cgImage.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else { return 0 }
        var rgba = [UInt8](repeating: 0, count: 4)
        let drawn = rgba.withUnsafeMutableBytes { bytes in
            CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                .map { $0.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1)); return true } ?? false
        }
        guard drawn else { return 0 }
        return (0.299 * CGFloat(rgba[0]) + 0.587 * CGFloat(rgba[1]) + 0.114 * CGFloat(rgba[2])) / 255
    }
}
