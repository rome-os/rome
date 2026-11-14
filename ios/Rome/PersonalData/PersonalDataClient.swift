import Foundation

// The instance's personal-data routes (`/api/personal-data/*`, guardian session only):
// the phone pushes readings there and reads what the Rome holds. Contract:
// docs/personal-data.md. The sync engine talks to `PersonalDataBackend`, which tests
// fill in with a fake.

/// One reading as the ingest takes it.
struct PersonalDataPoint: Codable, Equatable, Sendable {
    enum Shape: String, Codable, Sendable { case bucket, sample, record }

    /// Stable per reading, so a second send replaces the first.
    let key: String
    let type: String
    let shape: Shape
    /// `hour` or `day` for a bucket, nil otherwise.
    var resolution: String?
    let start: String
    let end: String
    /// The zone the phone was in, so a day keeps its local meaning.
    let tz: String
    var value: Double?
    var unit: String?
    /// Numbers only: min and max, sleep stage minutes, workout energy and distance.
    var fields: [String: Double]?
    /// Strings only, allow-listed by the Rome: a workout's `activity`, a sample's `sourceApp`.
    var metadata: [String: String]?
}

struct PersonalDataEnvelope: Encodable, Sendable {
    struct Origin: Encodable, Sendable {
        let id: String
        let name: String
        let platform: String
        let appVersion: String
    }

    struct Batch: Encodable, Sendable {
        let id: String
        let trigger: String
        let index: Int
        let last: Bool
    }

    struct TypeMark: Encodable, Sendable, Equatable {
        let type: String
        let syncedThrough: String
    }

    struct Delete: Encodable, Sendable, Equatable {
        let key: String
    }

    var version = 1
    let source: String
    let origin: Origin
    let batch: Batch
    let types: [TypeMark]
    let upserts: [PersonalDataPoint]
    let deletes: [Delete]
}

/// Why a call to the personal-data routes did not go through.
enum PersonalDataFailure: Error, Equatable, Sendable {
    /// The session is over and could not be renewed.
    case signedOut
    /// The Rome has no `/api/personal-data` routes: it needs an update.
    case needsUpdate
    /// Too many requests; try again after this many seconds, when it said.
    case rateLimited(TimeInterval?)
    /// The network, a timeout or the server: worth trying again later.
    case retryable(String)
    /// Refused for good (a 4xx): the same batch would be refused again.
    case refused(status: Int, code: String?)
    /// No guardian session on this phone to send with.
    case noInstance
}

protocol PersonalDataBackend: Sendable {
    func ingest(_ envelope: PersonalDataEnvelope) async throws(PersonalDataFailure) -> PersonalDataIngestReply
    func sources() async throws(PersonalDataFailure) -> [PersonalDataCatalogSource]
    func setState(source: String, origin: String, state: String) async throws(PersonalDataFailure)
    /// The number of readings removed; 0 when the Rome never had this origin.
    func deleteOrigin(source: String, origin: String) async throws(PersonalDataFailure) -> Int
}

/// Where the phone syncs: the Rome it opened last, with the guardian's session.
struct PersonalDataTarget: Sendable {
    let instanceId: String
    let backend: any PersonalDataBackend
}

/// The routes over the instance's `APIClient`.
struct PersonalDataClient: PersonalDataBackend {
    let client: APIClient

    func ingest(_ envelope: PersonalDataEnvelope) async throws(PersonalDataFailure) -> PersonalDataIngestReply {
        let body: Data
        do { body = try Self.encoder.encode(envelope) } catch { throw .refused(status: 0, code: "encode_failed") }
        let reply = try await call("POST", "/personal-data/ingest", body)
        return try decode(reply)
    }

    func sources() async throws(PersonalDataFailure) -> [PersonalDataCatalogSource] {
        let reply = try await call("GET", "/personal-data/sources", nil)
        let catalog: PersonalDataCatalog = try decode(reply)
        return catalog.sources ?? []
    }

    func setState(source: String, origin: String, state: String) async throws(PersonalDataFailure) {
        let body = try? JSONEncoder().encode(["state": state])
        do {
            _ = try await call("PUT", "/personal-data/sources/\(Self.segment(source))/origins/\(Self.segment(origin))/state", body)
        } catch .refused(status: 404, code: "unknown_origin") {
            // Nothing sent yet from this phone: nothing to mark.
        }
    }

    func deleteOrigin(source: String, origin: String) async throws(PersonalDataFailure) -> Int {
        do {
            let reply = try await call("DELETE", "/personal-data/sources/\(Self.segment(source))/origins/\(Self.segment(origin))", nil)
            let answer: PersonalDataDeleteReply = try decode(reply)
            return answer.deletedPoints ?? 0
        } catch .refused(status: 404, code: "unknown_origin") {
            return 0
        }
    }

    // MARK: Plumbing

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    private static func segment(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_."))) ?? text
    }

    private func call(_ method: String, _ path: String, _ body: Data?) async throws(PersonalDataFailure) -> APIClient.RawReply {
        let reply: APIClient.RawReply
        do {
            reply = try await client.raw(method, path, json: body)
        } catch APIError.unauthorized {
            throw .signedOut
        } catch is CancellationError {
            throw .retryable("cancelled")
        } catch {
            throw .retryable("network")
        }
        switch reply.status {
        case 200..<300: return reply
        case 429: throw .rateLimited(reply.retryAfter)
        case 408, 500...: throw .retryable("http_\(reply.status)")
        case 404 where reply.errorCode == nil:
            // A route the Rome does not have answers Hono's plain 404.
            throw .needsUpdate
        default: throw .refused(status: reply.status, code: reply.errorCode)
        }
    }

    private func decode<T: Decodable>(_ reply: APIClient.RawReply) throws(PersonalDataFailure) -> T {
        do { return try JSONDecoder().decode(T.self, from: reply.data) } catch { throw .retryable("decoding") }
    }
}
