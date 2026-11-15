import XCTest

/// Leg B of the voice input rules on iOS. It drives the Debug app on a simulator against the
/// stand-in instance, through the accessibility contract: the control is "Start voice input"
/// when idle, "Stop voice input" with the selected trait while listening, and "Finishing voice
/// input" while the last words arrive. The notice is its own element. Each test names the rule
/// it scores, so the verifier's report can say which leg scored which rule.
///
/// The stand-in instance comes from the CI job through `TEST_RUNNER_ROME_LOCAL_ORIGIN`,
/// `TEST_RUNNER_ROME_LOCAL_USER` and `TEST_RUNNER_ROME_LOCAL_PASSWORD`. Without them every test
/// skips and says so.
final class VoiceInputTests: XCTestCase {
    /// Rule 1's bar: the field shows listening, and idle again, within 0.5 s of the action.
    static let showSeconds: TimeInterval = 0.5
    /// Starts and stops per field; every one must meet the bar.
    static let repeats = 5

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: Rule 1

    /// Rule 1 in the Chat, the field the app opens on.
    @MainActor
    func testRule1TheChat() throws {
        let app = try launch()
        try checkStartsAndStops(app, field: "the Chat")
    }

    /// Rule 1 in a topic chat.
    @MainActor
    func testRule1ATopicChat() throws {
        let app = try launch()
        app.buttons["Open navigation"].tap()
        let existing = app.buttons.matching(identifier: "topic-chat").firstMatch
        if existing.waitForExistence(timeout: 3) {
            existing.tap()
        } else {
            app.buttons["New topic chat"].tap()
        }
        try checkStartsAndStops(app, field: "a topic chat")
    }

    /// Rule 1 in a task chat. Needs a task on the instance.
    @MainActor
    func testRule1ATaskChat() throws {
        let app = try launch()
        let card = app.buttons["task-card"].firstMatch
        guard card.waitForExistence(timeout: 10) else {
            throw XCTSkip("the instance has no task, so no task chat to open")
        }
        card.tap()
        try checkStartsAndStops(app, field: "a task chat")
    }

    /// Rule 1 in a thread under a Concierge message. Needs a task on the instance.
    @MainActor
    func testRule1AThread() throws {
        let app = try launch()
        let thread = app.buttons["thread-label"].firstMatch
        guard thread.waitForExistence(timeout: 10) else {
            throw XCTSkip("the instance has no task's thread to open")
        }
        thread.tap()
        try checkStartsAndStops(app, field: "a thread")
    }

    // MARK: Rules 2 and 3

    /// Rules 2 and 3, as far as the simulator goes: words show while the recording plays, and
    /// the field keeps them once listening stops. How fast and how right is leg A's to score.
    @MainActor
    func testRules2And3WordsShowWhileSpeakingAndStay() throws {
        let app = try launch(recording: "speech")
        let control = app.buttons["voice-input"]
        let field = app.textViews["message-field"]
        XCTAssertTrue(control.waitForExistence(timeout: 15), "the Chat has no voice control")
        control.tap()
        let words = NSPredicate(format: "value != nil AND value != ''")
        let shown = expectation(for: words, evaluatedWith: field)
        wait(for: [shown], timeout: 10)
        XCTAssertTrue(waitForLabel(control, "Stop voice input", timeout: 1), "listening ended on its own")
        control.tap()
        XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 15), "the control never returned to idle")
        XCTAssertFalse((field.value as? String ?? "").isEmpty, "the words were gone after the stop")
    }

    // MARK: Rule 8

    /// Rule 8 with the microphone refused, in English and Chinese: the control stays, a tap
    /// shows the notice saying how to allow it, and typing still sends.
    @MainActor
    func testRule8RefusedMicrophoneLeavesTypingWorking() throws {
        let cases: [(language: String, start: String, says: (String) -> Bool, wanted: String)] = [
            ("en", "Start voice input", { $0.localizedCaseInsensitiveContains("microphone") && $0.contains("Settings") },
             "a notice naming the microphone and Settings"),
            ("zh-Hans", "开始语音输入", { $0.contains("允许") }, "Chinese text that says to allow (允许) the microphone"),
        ]
        for item in cases {
            let app = try launch(microphone: "denied", language: item.language)
            let control = app.buttons["voice-input"]
            XCTAssertTrue(control.waitForExistence(timeout: 15), "\(item.language): no voice control when refused")
            XCTAssertEqual(control.label, item.start, "\(item.language): the control is not named in this language")
            control.tap()
            let notice = app.descendants(matching: .any)["voice-input-notice"]
            XCTAssertTrue(notice.waitForExistence(timeout: 5), "\(item.language): no notice within 5 s")
            XCTAssertTrue(item.says(notice.label), "\(item.language): the notice says \"\(notice.label)\"; wanted \(item.wanted)")
            let typed = "typed after refusing \(item.language) \(Int(Date().timeIntervalSince1970))"
            let field = app.textViews["message-field"]
            field.tap()
            field.typeText(typed)
            XCTAssertEqual(field.value as? String, typed, "\(item.language): a key was lost after the notice")
            app.buttons["send"].tap()
            XCTAssertTrue(app.staticTexts[typed].waitForExistence(timeout: 10), "\(item.language): the typed message was not sent")
            app.terminate()
        }
    }

    // MARK: Helpers

    /// Starts and stops `repeats` times in the open field, each within `showSeconds`, with the
    /// selected trait while listening.
    @MainActor
    private func checkStartsAndStops(_ app: XCUIApplication, field: String) throws {
        let control = app.buttons["voice-input"]
        XCTAssertTrue(control.waitForExistence(timeout: 15), "\(field) has no voice control")
        let messageField = app.textViews["message-field"]
        XCTAssertTrue(messageField.exists, "\(field) has no message field")
        let overhead = tapOverhead(messageField)
        for index in 1...Self.repeats {
            XCTAssertTrue(waitForLabel(control, "Start voice input", timeout: 15), "\(field): not idle before start \(index)")
            let start = timeToLabel(control, tap: true, ["Stop voice input"]) - overhead
            XCTAssertLessThanOrEqual(start, Self.showSeconds, "\(field): start \(index) showed after \(start) s")
            XCTAssertTrue(control.isSelected, "\(field): listening has no selected trait")
            let stop = timeToLabel(control, tap: true, ["Finishing voice input", "Start voice input"]) - overhead
            XCTAssertLessThanOrEqual(stop, Self.showSeconds, "\(field): stop \(index) showed after \(stop) s")
        }
    }

    /// Launches the app signed in to the stand-in instance, playing `recording` (a WAV in this
    /// bundle) as the microphone, or with the microphone as `microphone` says.
    @MainActor
    private func launch(recording: String = "speech", microphone: String? = nil, language: String = "en") throws -> XCUIApplication {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["ROME_LOCAL_ORIGIN"], let user = env["ROME_LOCAL_USER"],
              let password = env["ROME_LOCAL_PASSWORD"] else {
            throw XCTSkip("no stand-in instance: set TEST_RUNNER_ROME_LOCAL_ORIGIN, _USER and _PASSWORD")
        }
        let app = XCUIApplication()
        app.launchEnvironment["ROME_LOCAL_ORIGIN"] = origin
        app.launchEnvironment["ROME_LOCAL_USER"] = user
        app.launchEnvironment["ROME_LOCAL_PASSWORD"] = password
        app.launchArguments += ["-AppleLanguages", "(\(language))"]
        if let microphone {
            app.launchArguments += ["-RomeVoiceInputMicrophone", microphone]
        } else {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: recording, withExtension: "wav"),
                                    "\(recording).wav is missing from the test bundle")
            app.launchArguments += ["-RomeVoiceInputRecording", url.path]
        }
        app.launch()
        return app
    }

    /// How long a tap takes the test runner to deliver on an element that changes nothing, the
    /// fastest of three. Rule 1 times from the tap reaching the app, so this comes off each time.
    @MainActor
    private func tapOverhead(_ element: XCUIElement) -> TimeInterval {
        (0..<3).map { _ in
            let before = Date()
            element.tap()
            return Date().timeIntervalSince(before)
        }.min() ?? 0
    }

    /// Taps `control` when asked and returns the seconds until its label is one of `labels`,
    /// or infinity after 3 s.
    @MainActor
    private func timeToLabel(_ control: XCUIElement, tap: Bool, _ labels: [String]) -> TimeInterval {
        let tapped = Date()
        if tap { control.tap() }
        while Date().timeIntervalSince(tapped) < 3 {
            if labels.contains(control.label) { return Date().timeIntervalSince(tapped) }
        }
        return .infinity
    }

    @MainActor
    private func waitForLabel(_ control: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: control)
        return XCTWaiter().wait(for: [shown], timeout: timeout) == .completed
    }
}
