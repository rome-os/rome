import Foundation
import Testing
@testable import Rome

@Suite struct ConnectionPageTests {
    @Test func syncAloneKeepsTheRowOn() {
        // Sync runs whether or not Live access is on: the row shows either.
        #expect(ConnectionRowValue.text(connected: true, live: false, sync: .synced(.now)) == "On")
        #expect(ConnectionRowValue.text(connected: true, live: false, sync: .off) == "Off")
    }

    @Test func thePromisesLineLinksThePrivacyPolicyOverHTTPS() throws {
        let catalog = try Data(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "Rome/Localizable.xcstrings"))
        let strings = try #require(parseJSON(String(decoding: catalog, as: UTF8.self))["strings"]?.object)
        let key = try #require(strings.keys.first { $0.hasPrefix("Sent to your Rome and your AI model") })
        #expect(key.hasSuffix("[Privacy Policy](https://romeos.cc/privacy)"))
        let chinese = try #require(strings[key]?["localizations"]?["zh-Hans"]?["stringUnit"]?["value"]?.string)
        #expect(chinese.hasSuffix("[隐私政策](https://romeos.cc/privacy)"))
    }

    @Test func theHealthPinkIsOnlyDefinedOnce() throws {
        // Every other symbol on the page uses the app's own colors: the pink is a single token.
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "Rome/Features/Settings/ConnectionsScreen.swift"), encoding: .utf8)
        #expect(source.components(separatedBy: "healthPink").count - 1 == 1, "only the heart wears Health pink")
    }

    @Test func thePurposeStringSaysWhereHealthGoes() throws {
        let catalog = try Data(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "Rome/InfoPlist.xcstrings"))
        let entry = try #require(parseJSON(String(decoding: catalog, as: UTF8.self))["strings"]?["NSHealthShareUsageDescription"])
        let english = try #require(entry["localizations"]?["en"]?["stringUnit"]?["value"]?.string)
        #expect(english.contains("your Rome and your AI model"))
        #expect(!english.lowercased().contains("pause"), "there is no Pause")
        let chinese = try #require(entry["localizations"]?["zh-Hans"]?["stringUnit"]?["value"]?.string)
        #expect(chinese.contains("AI 模型") && !chinese.contains("暂停"))
    }
}
