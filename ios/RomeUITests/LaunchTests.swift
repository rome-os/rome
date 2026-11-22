import XCTest

/// Proves the UI test target builds and drives the Debug app. The voice input
/// checks live with the verifier and launch the app the same way, adding
/// `-RomeVoiceInputRecording <wav>` to play a recording as the microphone.
final class LaunchTests: XCTestCase {
    @MainActor
    func testTheDemoAppOpens() {
        let app = XCUIApplication.forUITests()
        app.launchEnvironment["ROME_DEMO"] = "1"
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
    }
}
