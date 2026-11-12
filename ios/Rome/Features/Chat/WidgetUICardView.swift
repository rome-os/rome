import A2UICore
import A2UISwiftUI
import SwiftUI

/// A card described as data, drawn natively. Google's A2UI engine reads the
/// card, resolves its paths and keeps its data; `WidgetCatalog` draws it.
/// Each `bind` is read from the app's API when the card appears, so it shows
/// the app's data as it stands. A button POSTs its context to the app's API
/// and reads every `bind` again; nothing is said in the chat.
struct WidgetUICardView: View {
    let part: WidgetUIPart
    /// A call on the card's own app: method, path in its API, JSON body.
    let call: (String, String, Rome.JSONValue?) async throws -> ConnectReply

    @StateObject private var surface = WidgetSurface()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let viewModel = surface.viewModel {
                Surface(viewModel: viewModel, catalog: WidgetCatalog.catalog)
                    .environment(\.widgetBusy, surface.busy || !surface.loaded)
            } else if surface.undrawable {
                Text("Could not show this card. \(part.text)")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if surface.failed {
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
            surface.show(part, call: call)
            await surface.load()
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
    @Published private(set) var undrawable = false
    @Published private(set) var busy = false

    private var processor: MessageProcessor?
    private var part: WidgetUIPart?
    private var call: ((String, String, Rome.JSONValue?) async throws -> ConnectReply)?
    /// Only the newest read writes the data: a slow read must not land after
    /// a newer one and put back an older value.
    private var reads = 0

    func show(_ part: WidgetUIPart, call: @escaping (String, String, Rome.JSONValue?) async throws -> ConnectReply) {
        guard self.part != part else { return }
        self.part = part
        self.call = call
        loaded = false
        failed = false
        // A stored part is read back as data, so it is checked again here.
        guard part.isDrawable else {
            undrawable = true
            return
        }
        let processor = MessageProcessor(catalogs: [WidgetCatalog.catalog], actionHandler: self)
        self.processor = processor
        let surfaceId = Rome.JSONValue.string(part.toolUseId)
        let created = send("createSurface", [
            "surfaceId": surfaceId, "catalogId": .string(WidgetCatalog.id),
        ]) && send("updateComponents", [
            "surfaceId": surfaceId, "components": .array(part.components),
        ])
        viewModel = created ? processor.surfaceGroupModel.surfacesMap[part.toolUseId] : nil
        undrawable = viewModel == nil
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
        guard let call, !busy, WidgetPaths.isAppPath(name) else { return }
        busy = true
        defer { busy = false }
        do {
            let reply = try await call("POST", name, body)
            if !reply.ok { failed = true; return }
            await load()
        } catch {
            failed = true
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
