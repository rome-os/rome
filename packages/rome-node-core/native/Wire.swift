import CryptoKit
import Darwin
import Foundation

struct Request: Decodable {
    let v: Int
    let id: String
    let method: String
    let params: Parameters?

    struct Parameters: Decodable {
        let nonce: String?
        let proof: String?
        let application: String?
        let window: UInt32?
        let binding: String?
        let screenshot: Bool?
        let element: String?
        let action: String?
        let value: Value?
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
