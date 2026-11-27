import Foundation

/// `GET /chat/sessions/:id/outputs`: the files the chat's agent wrote or
/// showed, newest first. A Concierge chat's list holds its task chats' too.
/// Only the fields the app reads; the wire type is
/// `packages/api-types/src/chat-outputs.ts`. docs/domains/chats.md#outputs
struct ChatOutputsResponse: Decodable, Hashable, Sendable {
    var outputs: [ChatOutput]
    /// Outputs from before Rome recorded them are still being read back, so
    /// the list may grow.
    var indexing: Bool

    private enum CodingKeys: String, CodingKey { case outputs, indexing }

    init(outputs: [ChatOutput], indexing: Bool = false) {
        self.outputs = outputs
        self.indexing = indexing
    }

    /// A row this build cannot read is left out, never the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outputs = try c.decode([Lenient<ChatOutput>].self, forKey: .outputs).compactMap(\.value)
        indexing = try c.decodeIfPresent(Bool.self, forKey: .indexing) ?? false
    }

    private struct Lenient<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }
}

/// One file, at the latest time the agent wrote or showed it.
struct ChatOutput: Codable, Identifiable, Hashable, Sendable {
    /// The task chat a Concierge chat's output came from.
    struct Source: Codable, Hashable, Sendable {
        var chatId: String
        var name: String
    }

    let id: String
    /// `written` or `shown`.
    var kind: String
    var name: String
    /// The link a chat message gives the file: `/projects/<project>/<path>`
    /// or `/api/assets/<name>`; nil when it has none.
    var link: String?
    var mimeType: String?
    /// What it previews as (`FileKind`'s raw value); nil from an older server.
    var fileKind: String?
    /// ISO 8601.
    var at: String
    /// The file is gone from where it was written, or the shown copy is.
    var missing: Bool
    var from: Source?
    /// `/api/chat/sessions/:id/outputs/:outputId/content`; nil while the file
    /// cannot be served.
    var contentUrl: String?

    var date: Date? { RomeDate.parse(at) }
}
