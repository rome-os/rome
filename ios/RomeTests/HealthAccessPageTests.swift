import Foundation
import Testing
@testable import Rome

@Suite struct HealthAccessPageTests {
    @Test func theRowShowsOnOrOff() {
        #expect(HealthRowState(healthOn: true, deviceOn: true).value == "On")
        #expect(HealthRowState(healthOn: false, deviceOn: true).value == "Off")
        // The state shows even while the row is dimmed.
        #expect(HealthRowState(healthOn: true, deviceOn: false).value == "On")
        #expect(HealthRowState(healthOn: false, deviceOn: false).value == "Off")
    }

    @Test func theRowIsDimmedOnlyWhileThePhoneIsOffLimits() {
        #expect(HealthRowState(healthOn: true, deviceOn: true).opacity == 1)
        #expect(HealthRowState(healthOn: false, deviceOn: true).opacity == 1)
        #expect(HealthRowState(healthOn: true, deviceOn: false).opacity < 1)
        #expect(HealthRowState(healthOn: false, deviceOn: false).opacity < 1)
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
