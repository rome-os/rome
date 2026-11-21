import Foundation
import Testing
@testable import Rome

/// The Access service token goes only to Rome's test hosts.
@Suite struct DevAccessTests {
    @Test func aHostOutsideRomeosDevGetsNoToken() {
        for url in ["https://romeos.cc/api", "https://evil.example/romeos.dev", "https://romeos.dev.evil.example/"] {
            var request = URLRequest(url: URL(string: url)!)
            DevAccess.stamp(&request)
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == nil)
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == nil)
        }
    }
}
