import XCTest

extension XCUIApplication {
    /// The Debug app as every UI test launches it. It leaves out the chat
    /// header's blur, whose paused animators keep XCUITest from finding the app
    /// idle, so each tap would first wait 60 s for an idle that never comes.
    @MainActor
    static func forUITests() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-RomeUITestsNoHeaderBlur", "YES"]
        return app
    }
}
