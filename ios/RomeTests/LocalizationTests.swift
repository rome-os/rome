import Foundation
import Testing
@testable import Rome

/// English is the source language; every key needs its Simplified Chinese text.
@Suite struct LocalizationTests {
    private static let catalogURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appending(path: "Rome/Localizable.xcstrings")

    private static func catalog() throws -> [String: Any] {
        let data = try Data(contentsOf: catalogURL)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The `%@` and `%lld` placeholders in a string, in order.
    private static func placeholders(_ text: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: "%(lld|@)")
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { (text as NSString).substring(with: $0.range) }
    }

    @Test func sourceLanguageIsEnglish() throws {
        #expect(try Self.catalog()["sourceLanguage"] as? String == "en")
    }

    @Test func everyKeyHasChinese() throws {
        let strings = try #require(try Self.catalog()["strings"] as? [String: [String: Any]])
        #expect(!strings.isEmpty)
        for (key, entry) in strings where entry["shouldTranslate"] as? Bool != false {
            let localizations = entry["localizations"] as? [String: Any]
            let chinese = localizations?["zh-Hans"] as? [String: Any]
            let unit = chinese?["stringUnit"] as? [String: Any]
            let value = unit?["value"] as? String ?? ""
            #expect(!value.isEmpty, "No zh-Hans text for \"\(key)\"")
            #expect(unit?["state"] as? String == "translated", "zh-Hans text for \"\(key)\" is not marked translated")
            let english = ((localizations?["en"] as? [String: Any])?["stringUnit"] as? [String: Any])?["value"] as? String ?? key
            #expect(Self.placeholders(value) == Self.placeholders(english), "Placeholders differ for \"\(key)\"")
        }
    }

    @Test func builtAppCarriesChinese() throws {
        let path = try #require(Bundle.main.path(forResource: "zh-Hans", ofType: "lproj"))
        let chinese = try #require(Bundle(path: path))
        #expect(chinese.localizedString(forKey: "Needs you", value: nil, table: nil) == "等你处理")
        let format = chinese.localizedString(forKey: "%lld minutes ago", value: nil, table: nil)
        #expect(String.localizedStringWithFormat(format, 10) == "10 分钟前")
    }

    @Test func englishPluralsAgree() {
        #expect(String(localized: "Used \(1) tools") == "Used 1 tool")
        #expect(String(localized: "Used \(3) tools") == "Used 3 tools")
    }
}
