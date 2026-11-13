import A2UICore
import A2UISwiftUI
import SwiftUI

/// A card described as data, drawn natively. Google's A2UI engine reads the
/// card, resolves its paths and keeps its data; `WidgetCatalog` draws it.
/// Each `bind` is read from the app's API when the card appears, so it shows
/// the app's data as it stands. Every event goes to core, which decides what it
/// means; the card only sends it. A card the agent waits on is sent once core
/// takes the event, and its turn reaches the chat with the next read.
struct WidgetUICardView: View {
    /// A card the agent waits on: the stored answer once there is one, which
    /// locks the card.
    struct Waiting {
        let answered: Rome.JSONValue?
    }

    let part: WidgetUIPart
    /// A read of the card's own app: method, path in its API, JSON body.
    let call: (String, String, Rome.JSONValue?) async throws -> ConnectReply
    /// A press on a button, sent to core: event name and context.
    var press: (String, Rome.JSONValue) async throws -> WidgetEventReply = { _, _ in throw APIError.notFound }
    var waiting: Waiting? = nil

    private var locked: Bool { waiting?.answered != nil || surface.sent }

    @StateObject private var surface = WidgetSurface()
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let viewModel = surface.viewModel {
                Surface(viewModel: viewModel, catalog: WidgetCatalog.catalog)
                    .environment(\.widgetBusy, surface.busy || !surface.loaded)
                    .environment(\.widgetLocked, locked)
                    .environment(\.widgetClears, surface.clears)
            } else if surface.undrawable {
                Text("Could not show this card. \(part.text)")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let answered = waiting?.answered {
                Text(answered["dismissed"]?.bool == true ? "Dismissed" : "Answered")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            } else if surface.sent {
                Text("Sent")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            }
            if surface.sendFailed {
                Text("Couldn't send your answer. Your choices are kept")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            } else if surface.failed {
                Text("Could not read this card's data. \(part.text)")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardPadding()
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
        .padding(.top, 4)
        .redacted(reason: surface.loaded || surface.failed || surface.undrawable ? [] : .placeholder)
        .task(id: part) {
            surface.answered = waiting?.answered != nil
            surface.show(part, call: call, press: press, open: { openURL($0) })
            surface.showAnswered(waiting?.answered)
            await surface.load()
        }
        .onChange(of: waiting?.answered) {
            surface.answered = waiting?.answered != nil
            surface.showAnswered(waiting?.answered)
        }
    }
}

/// One card's A2UI surface: the engine that holds it, the reads that fill it,
/// and the presses it posts.
@MainActor
final class WidgetSurface: ObservableObject, ActionHandling {
    @Published private(set) var viewModel: SurfaceViewModel?
    @Published private(set) var loaded = false
    @Published private(set) var failed = false
    /// Core did not take the last event the card sent.
    @Published private(set) var sendFailed = false
    @Published private(set) var undrawable = false
    @Published private(set) var busy = false
    @Published private(set) var clears = WidgetClears()
    /// Set once core takes an event on a card the agent waits on.
    @Published private(set) var sent = false
    /// Whether the card the agent waits on is answered, as stored.
    var answered = false

    private var processor: MessageProcessor?
    private var part: WidgetUIPart?
    private var call: ((String, String, Rome.JSONValue?) async throws -> ConnectReply)?
    private var send: ((String, Rome.JSONValue) async throws -> WidgetEventReply)?
    private var open: (URL) -> Void = { _ in }
    /// Only the newest read writes the data: a slow read must not land after
    /// a newer one and put back an older value.
    private var reads = 0

    func show(
        _ part: WidgetUIPart,
        call: @escaping (String, String, Rome.JSONValue?) async throws -> ConnectReply,
        press: @escaping (String, Rome.JSONValue) async throws -> WidgetEventReply = { _, _ in throw APIError.notFound },
        open: @escaping (URL) -> Void = { _ in }
    ) {
        self.open = open
        guard self.part != part else { return }
        self.part = part
        self.call = call
        self.send = press
        loaded = false
        failed = false
        sendFailed = false
        // A stored part is read back as data, so it is checked again here.
        guard part.isDrawable else {
            undrawable = true
            return
        }
        let processor = MessageProcessor(catalogs: [WidgetCatalog.catalog], actionHandler: self)
        self.processor = processor
        let surfaceId = Rome.JSONValue.string(part.toolUseId)
        var targets: [String: String] = [:]
        let components = part.components.map { component -> Rome.JSONValue in
            guard case .object(var fields) = Self.withHostStrings(component) else { return component }
            if let id = fields["id"]?.string, let target = fields["clears"]?["path"]?.string { targets[id] = target }
            fields["clears"] = nil
            return .object(fields)
        }
        let created = send("createSurface", [
            "surfaceId": surfaceId, "catalogId": .string(WidgetCatalog.id),
        ]) && send("updateComponents", [
            "surfaceId": surfaceId, "components": .array(components),
        ]) && (part.data.object ?? [:]).allSatisfy { key, value in
            // A key is one JSON Pointer token: `~` and `/` are escaped.
            let token = key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
            return send("updateDataModel", ["surfaceId": surfaceId, "path": .string("/\(token)"), "value": value])
        }
        viewModel = created ? processor.surfaceGroupModel.surfacesMap[part.toolUseId] : nil
        undrawable = viewModel == nil
        clears = WidgetClears(targets: targets) { [weak self] path, list in
            self?.viewModel?.dataModel.set(path, value: list ? .array([]) : .string(""))
        }
    }

    /// An answered card shows what the guardian sent, which core keeps as
    /// `card`. A dismissed card was never answered, so it shows nothing
    /// picked rather than its defaults.
    func showAnswered(_ answered: Rome.JSONValue?) {
        guard let part, viewModel != nil else { return }
        let dismissed = answered?["dismissed"]?.bool == true
        guard let card = answered?["card"] ?? Self.sentCard(answered) ?? (dismissed ? .array([]) : nil) else { return }
        _ = send("updateDataModel", ["surfaceId": .string(part.toolUseId), "path": .string("/answers"), "value": card])
    }

    /// What the card sent, before core has stored it as `card`: answers in the
    /// card's own shape (`values` and `text`, no `questionId`).
    static func sentCard(_ answered: Rome.JSONValue?) -> Rome.JSONValue? {
        guard let answers = answered?["answers"]?.array, !answers.isEmpty,
              answers.allSatisfy({ $0["questionId"] == nil && $0["values"] != nil })
        else { return nil }
        return .array(answers)
    }

    /// The card's components with each `{ string }` replaced by Rome's own
    /// string in the guardian's language. A button's `action` is the app's
    /// data, not something shown, so it is sent as written, as the web does.
    static func withHostStrings(_ value: Rome.JSONValue) -> Rome.JSONValue {
        switch value {
        case .object(let fields):
            if fields.count == 1, let name = fields["string"]?.string { return .string(WidgetPaths.hostString(name)) }
            return .object(Dictionary(uniqueKeysWithValues: fields.map { key, field in
                (key, key == "action" ? field : withHostStrings(field))
            }))
        case .array(let items):
            return .array(items.map(withHostStrings))
        default:
            return value
        }
    }

    func load() async {
        guard let part, let call, viewModel != nil else { return }
        reads += 1
        let read = reads
        var values: [(String, Rome.JSONValue)] = []
        do {
            for (pointer, path) in part.bind.sorted(by: { $0.key < $1.key }) {
                let reply = try await call("GET", path, nil)
                guard reply.ok else { throw APIError.server(status: 500, message: nil) }
                values.append((pointer, reply.body))
            }
            guard read == reads else { return }
            for (pointer, value) in values {
                _ = send("updateDataModel", [
                    "surfaceId": .string(part.toolUseId), "path": .string(pointer), "value": value,
                ])
            }
            failed = false
        } catch {
            if read == reads { failed = true }
        }
        loaded = true
    }

    nonisolated func handle(action: ResolvedAction, from surfaceID: String) {
        guard case .event(let name, let context, _) = action.identity else { return }
        let body = Self.romeJSON(context ?? [:])
        Task { @MainActor in await self.press(name, body: body) }
    }

    nonisolated func handle(error: RendererError, from surfaceID: String) {}

    private func press(_ name: String, body: Rome.JSONValue) async {
        // Core decides what every event means; the card only sends it.
        let waits = part?.waits == true
        guard let send, !busy, !(waits && (answered || sent)) else { return }
        busy = true
        defer { busy = false }
        do {
            let reply = try await send(name, body)
            // A link the reply names opens; a card core says is answered is
            // sent, and any other card reads its data again, and that read
            // says whether the card's data failed.
            sendFailed = false
            failed = false
            if let url = reply.open { open(url) }
            if waits && reply.answered { sent = true } else { await load() }
        } catch {
            sendFailed = true
        }
    }

    /// Hands one A2UI v0.9 message to the engine; false when it refuses it.
    private func send(_ kind: String, _ body: [String: Rome.JSONValue]) -> Bool {
        let message = Rome.JSONValue.object(["version": .string("v0.9"), kind: .object(body)])
        guard let processor,
              let data = try? JSONEncoder().encode(message),
              let text = String(data: data, encoding: .utf8),
              let parsed = try? MessageParser().parse(jsonString: text) else { return false }
        processor.process(message: parsed)
        return true
    }

    /// The engine's JSON as the app's, through their shared encoding.
    private nonisolated static func romeJSON<T: Encodable>(_ value: T) -> Rome.JSONValue {
        guard let data = try? JSONEncoder().encode(value),
              let json = try? JSONDecoder().decode(Rome.JSONValue.self, from: data) else { return .object([:]) }
        return json
    }
}
