import Foundation
import Testing
@testable import Rome

@Suite struct HealthAccessPageTests {
    @Test func theRowIsNotDimmedByIPhoneUse() {
        // Sync runs whether or not Rome may use the phone live: the row shows its own state.
        #expect(HealthRowState(status: .synced(.now)).value == "On")
        #expect(HealthRowState(status: .off).value == "Off")
    }

    @Test func thePrivacyPolicyIsOnRomesSiteOverHTTPS() {
        #expect(HealthAccessScreen.privacyURL.absoluteString == "https://romeos.cc/privacy")
    }

    @Test func theHealthPinkIsOnlyDefinedOnce() throws {
        // Every other symbol on the page uses the app's own colors: the pink is a single token.
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "Rome/Features/Settings/HealthAccessScreen.swift"), encoding: .utf8)
        #expect(source.components(separatedBy: "healthPink").count - 1 == 1, "only the heart wears Health pink")
    }
}
