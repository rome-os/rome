import Foundation
import Testing
import UIKit
@testable import Rome

@MainActor
@Suite struct AppearanceTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "appearance-\(UUID())")! }

    @Test func automaticByDefault() {
        let setting = AppearanceSetting(defaults: defaults())
        #expect(setting.current == .automatic)
        #expect(setting.current.style == .unspecified)
    }

    @Test func theChoiceIsKeptOnThePhone() {
        let store = defaults()
        AppearanceSetting(defaults: store).set(.dark)
        // A relaunch reads it back.
        #expect(AppearanceSetting(defaults: store).current == .dark)
        AppearanceSetting(defaults: store).set(.light)
        #expect(AppearanceSetting(defaults: store).current == .light)
    }

    @Test func eachChoiceMapsToAWindowStyle() {
        #expect(Appearance.light.style == .light)
        #expect(Appearance.dark.style == .dark)
        #expect(Appearance.automatic.style == .unspecified)
    }

    @Test func anUnknownStoredValueFallsBackToAutomatic() {
        let store = defaults()
        store.set("sepia", forKey: AppearanceSetting.key)
        #expect(AppearanceSetting(defaults: store).current == .automatic)
    }
}
