import CryptoKit
import Darwin
import Foundation

struct Request: Decodable {
    let v: Int
    let id: String
    let method: String
    let params: Parameters?

    private enum CodingKeys: String, CodingKey {
        case v, id, method, params
    }

    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        v = try fields.decode(Int.self, forKey: .v)
        id = try fields.decode(String.self, forKey: .id)
        method = try fields.decode(String.self, forKey: .method)
        if method == "authorize" {
            // Preserve the request ID so an invalid proof consumes the challenge and receives auth_failed.
            params = try? fields.decode(Parameters.self, forKey: .params)
        } else {
            params = try fields.decodeIfPresent(Parameters.self, forKey: .params)
        }
    }

    struct Parameters: Decodable {
        let afterRevision: Int?
        let nonce: String?
        let proof: String?
        let signature: String?
        let application: String?
        let window: UInt32?
        let binding: String?
        let screenshot: Bool?
        let element: String?
        let action: String?
        let value: Value?
        let x: Double?
        let y: Double?
        let toX: Double?
        let toY: Double?
        let button: String?
        let clickCount: Int?
        let steps: Int?
        let deltaX: Double?
        let deltaY: Double?
        let modifiers: [String]?
        let key: String?
        let text: String?
    }

    enum Value: Decodable {
        case text(String), checked(Bool), number(Double)

        init(from decoder: Decoder) throws {
            let value = try decoder.singleValueContainer()
            if let text = try? value.decode(String.self), text.utf8.count <= 16_384 {
                self = .text(text)
            } else if let checked = try? value.decode(Bool.self) {
                self = .checked(checked)
            } else if let number = try? value.decode(Double.self), number.isFinite {
                self = .number(number)
            } else {
                throw Failure("invalid_request")
            }
        }
    }
}

enum ConsentDecision: Int, Sendable {
    case deny = 1000, allowSession, allowPersistent
}

enum ConsentMode: String, Decodable, Sendable {
    case sessionOnly = "session_only"
    case persistentOnly = "persistent_only"
    case sessionOrPersistent = "session_or_persistent"

    var choices: [ConsentDecision] {
        switch self {
        case .sessionOnly: [.deny, .allowSession]
        case .persistentOnly: [.deny, .allowPersistent]
        case .sessionOrPersistent: [.deny, .allowSession, .allowPersistent]
        }
    }
}

struct ControllerClaim: Sendable {
    let key: ControllerKey
    let label: String
    let scope: ControllerScope
}

struct Hello {
    let locale: HelperLocale
    let mode: ConsentMode
    let consentTimeoutMs: Int
    let includeAccess: Bool
    let controller: ControllerClaim?

    private struct Envelope: Decodable {
        let params: Options
    }

    private struct Options: Decodable {
        struct Controller: Decodable {
            let publicKey: String
            let label: String
            let scope: ControllerScope
        }

        let locale: String?
        let mode: ConsentMode
        let consentTimeoutMs: Int
        let includeAccess: Bool
        let controller: Controller?

        private enum CodingKeys: String, CodingKey {
            case locale, consentMode, controller, consentTimeoutMs, includeAccess
        }

        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            locale = try fields.decodeIfPresent(String.self, forKey: .locale)
            mode = try fields.contains(.consentMode) ? fields.decode(ConsentMode.self, forKey: .consentMode) : .sessionOnly
            includeAccess = try fields.decodeIfPresent(Bool.self, forKey: .includeAccess) ?? false
            consentTimeoutMs = try fields.decodeIfPresent(Int.self, forKey: .consentTimeoutMs) ?? 180_000
            guard (1...180_000).contains(consentTimeoutMs) else { throw Failure("invalid_request") }
            controller = try fields.contains(.controller) ? fields.decode(Controller.self, forKey: .controller) : nil
        }
    }

    init(_ data: Data, preferred: [String]) throws {
        guard let options = (try? JSONDecoder().decode(Envelope.self, from: data))?.params else {
            throw Failure("invalid_request")
        }
        locale = resolveLocale(requested: options.locale, preferred: preferred)
        includeAccess = options.includeAccess
        consentTimeoutMs = options.consentTimeoutMs
        mode = options.mode
        if let claim = options.controller, let label = sanitizeLabel(claim.label) {
            controller = try ControllerClaim(key: ControllerKey(claim.publicKey), label: label, scope: claim.scope)
        } else {
            guard options.controller == nil, mode == .sessionOnly else { throw Failure("invalid_request") }
            controller = nil
        }
    }
}

struct ControllerChallenge: Sendable {
    let base64: String
    let expires: DispatchTime
    private let key: ControllerKey
    private let payload: Data

    init(instance: String, helper: pid_t, host: pid_t, controller: ControllerClaim, mode: ConsentMode,
         now: DispatchTime = .now()) {
        base64 = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0).base64EncodedString() }
        expires = now + .seconds(60)
        key = controller.key
        payload = Data([
            "rome-computer-use-auth-v1", instance, String(helper), String(host),
            base64, controller.key.base64, controller.scope.rawValue, mode.rawValue,
        ].joined(separator: "\n").utf8)
    }

    func verifies(_ signature: String?, now: DispatchTime = .now()) -> Bool {
        guard now < expires, let signature, let bytes = Data(base64Encoded: signature),
              bytes.count == 64, bytes.base64EncodedString() == signature else { return false }
        return key.signingKey.isValidSignature(bytes, for: payload)
    }
}

// Two big-endian UInt32 lengths precede the JSON and optional PNG. See README.md.
enum Wire {
    static let metadataLimit = 256 * 1024
    static let imageLimit = 8 * 1024 * 1024
    static let dimensionLimit = 2048
    static let pixelLimit = 2048 * 1536

    static func lengths(_ header: Data, request: Bool) throws -> (Int, Int) {
        guard header.count == 8 else { throw Failure("invalid_frame") }
        let metadata = integer(header.prefix(4))
        let binary = integer(header.suffix(4))
        guard metadata > 0, metadata <= metadataLimit, binary <= (request ? 0 : imageLimit) else {
            throw Failure("frame_limit")
        }
        return (metadata, binary)
    }

    static func integer(_ bytes: Data.SubSequence) -> Int {
        bytes.reduce(0) { ($0 << 8) | Int($1) }
    }

    static func frame(_ message: [String: Any], binary: Data = Data()) throws -> Data {
        let json = try JSONSerialization.data(withJSONObject: message)
        var header = Data()
        for size in [json.count, binary.count] {
            guard let count = UInt32(exactly: size) else { throw Failure("frame_limit") }
            var countBE = count.bigEndian
            withUnsafeBytes(of: &countBE) { header.append(contentsOf: $0) }
        }
        _ = try lengths(header, request: false)
        header.append(json)
        header.append(binary)
        return header
    }

    static func request(_ json: Data) throws -> Request {
        guard let request = try? JSONDecoder().decode(Request.self, from: json),
              !request.id.isEmpty, request.id.utf8.count <= 64,
              !request.method.isEmpty, request.method.utf8.count <= 32 else { throw Failure("invalid_request") }
        return request
    }

    static func reply(_ id: String?, result: [String: Any], image: Image? = nil) throws -> Data {
        var result = result
        if let image {
            result["screenshot"] = ["mimeType": "image/png", "width": image.width, "height": image.height,
                                    "bytes": image.png.count] as [String: Any]
        }
        return try frame(["v": 1, "id": id as Any? ?? NSNull(), "ok": true, "result": result],
                         binary: image?.png ?? Data())
    }

    static func failure(_ id: String?, _ code: String) throws -> Data {
        try frame(["v": 1, "id": id as Any? ?? NSNull(), "ok": false, "error": ["code": code]])
    }

    struct Image {
        let png: Data
        let width: Int
        let height: Int

        static func checkSize(_ width: Int, _ height: Int) throws {
            guard (1...Wire.dimensionLimit).contains(width), (1...Wire.dimensionLimit).contains(height),
                  width * height <= Wire.pixelLimit else { throw Failure("capture_limit") }
        }

        init(png: Data, width: Int, height: Int) throws {
            try Self.checkSize(width, height)
            guard (33...Wire.imageLimit).contains(png.count),
                  png.prefix(16) == Data([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]),
                  Wire.integer(png[16..<20]) == width, Wire.integer(png[20..<24]) == height else {
                throw Failure("capture_limit")
            }
            self.png = png
            self.width = width
            self.height = height
        }
    }
}

struct Handshake {
    let key: SymmetricKey
    let host: pid_t

    private func message(_ fields: [String]) -> Data {
        Data((["rome-computer-use-v1"] + fields).joined(separator: "\n").utf8)
    }

    func verifyHost(_ proof: Data, nonce: Data) -> Bool {
        nonce.count == 32 && proof.count == 32 && HMAC<SHA256>.isValidAuthenticationCode(
            proof, authenticating: message(["host", String(host), nonce.base64EncodedString()]), using: key)
    }

    func helperProof(helper: pid_t, nonce: Data, instance: String) -> Data {
        let payload = message(["helper", String(host), String(helper), nonce.base64EncodedString(), instance])
        return Data(HMAC<SHA256>.authenticationCode(for: payload, using: key))
    }
}
