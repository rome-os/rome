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

    /// Used where no list keeps the card's surface.
    @StateObject private var own = WidgetSurface()
    @Environment(\.widgetSurfaces) private var kept

    var body: some View {
        WidgetCardBody(part: part, call: call, press: press, waiting: waiting, surface: kept?.surface(for: part.toolUseId) ?? own)
    }
}

/// Cards whose surfaces outlive their views. A list that rebuilds a row
/// scrolled away (a reused cell) would otherwise lose the guardian's unsent
/// answers, and a sent card would unlock again.
@MainActor
final class WidgetSurfaces {
    private var surfaces: [String: WidgetSurface] = [:]

    /// A tool use id repeats across turns, so a card is known by its row too.
    func surface(row: String, card: String) -> WidgetSurface {
        let key = "\(row)/\(card)"
        if let surface = surfaces[key] { return surface }
        let surface = WidgetSurface()
        surfaces[key] = surface
        return surface
    }

    /// The surfaces of the cards in one row.
    func row(_ id: String) -> Row { Row(surfaces: self, id: id) }

    @MainActor
    struct Row {
        let surfaces: WidgetSurfaces
        let id: String

        func surface(for card: String) -> WidgetSurface { surfaces.surface(row: id, card: card) }
    }
}

extension EnvironmentValues {
    @Entry var widgetSurfaces: WidgetSurfaces.Row? = nil
}

private struct WidgetCardBody: View {
    let part: WidgetUIPart
    let call: (String, String, Rome.JSONValue?) async throws -> ConnectReply
    let press: (String, Rome.JSONValue) async throws -> WidgetEventReply
    let waiting: WidgetUICardView.Waiting?
    @ObservedObject var surface: WidgetSurface
    @Environment(\.openURL) private var openURL
    @Environment(\.connectDevice) private var connectDevice

    private var locked: Bool { waiting?.answered != nil || surface.sent || surface.autoSharing }

    /// A share the card made by itself, as core stored it: no question the
    /// guardian answered, so it shows as one line in place of the card.
    private var autoShared: JSONValue? {
        guard let answered = waiting?.answered, answered["auto"]?.bool == true, LocationCard.isLocationCard(part) else { return nil }
        return answered
    }

    var body: some View {
        // One container whatever shows, so the card's reads and its share
        // keep one task while the branch inside changes.
        VStack(spacing: 0) {
            if let answered = autoShared ?? surface.autoSent {
                // In the thread label's style: a quiet line, not a card. Until
                // the stored answer arrives, the share just sent says it.
                Text(verbatim: LocationCard.outcome(answered))
                    .romeFont(12)
                    .foregroundStyle(Palette.sub.opacity(0.75))
                    .padding(.horizontal, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if surface.autoSharing, !surface.sendFailed, LocationCard.isLocationCard(part) {
                // While the card shares by itself, nothing shows.
                Color.clear.frame(height: 0)
            } else {
                card
            }
        }
        .task(id: part) {
            surface.answered = waiting?.answered != nil
            surface.show(part, call: call, press: press, open: { openURL($0) }, connectDevice: { [connectDevice] url in
                await connectDevice?.run(url)
            })
            surface.showAnswered(waiting?.answered)
            await surface.load()
            await surface.shareIfAllowed()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            Task { await surface.shareIfAllowed() }
        }
        .onChange(of: waiting?.answered) {
            surface.answered = waiting?.answered != nil
            surface.showAnswered(waiting?.answered)
        }
    }

    private var card: some View {
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
            if let answered = waiting?.answered, LocationCard.isLocationCard(part) {
                Text(verbatim: LocationCard.outcome(answered))
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            } else if let answered = waiting?.answered {
                Text(answered["dismissed"]?.bool == true ? "Dismissed" : answered["status"]?.string == "connected" ? "Connected" : "Answered")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            } else if surface.locating {
                Text("Finding your location…")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            } else if surface.sent {
                Text("Sent")
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.sub)
            }
            // An answered card shows how it ended, never a failed send: the
            // answer landed, whichever press or client sent it.
            if waiting?.answered != nil {
                EmptyView()
            } else if surface.sendFailed, let why = surface.refusal {
                Text(verbatim: why)
                    .romeFont(CardScale.caption)
                    .foregroundStyle(Palette.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            } else if surface.sendFailed {
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
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Palette.elevated, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .hairline(radius: Metrics.cardRadius)
        .padding(.top, 4)
        .redacted(reason: surface.loaded || surface.failed || surface.undrawable ? [] : .placeholder)
    }
}

/// One card's A2UI surface: the engine that holds it, the reads that fill it,
/// and the presses it posts.
@MainActor
final class WidgetSurface: ObservableObject, ActionHandling {
    @Published private(set) var viewModel: SurfaceViewModel?
    @Published private(set) var loaded = false
    @Published private(set) var failed = false
    /// A share the card sent by itself and core took, as its answer reads,
    /// until the stored answer arrives.
    @Published private(set) var autoSent: Rome.JSONValue?
    /// Core did not take the last event the card sent.
    @Published private(set) var sendFailed = false
    /// Why core or the card's owner refused the last event, when it said.
    @Published private(set) var refusal: String?
    @Published private(set) var undrawable = false
    @Published private(set) var busy = false
    @Published private(set) var clears = WidgetClears()
    /// Set once core takes an event on a card the agent waits on.
    @Published private(set) var sent = false
    /// The share-location card is reading the phone's position.
    @Published private(set) var locating = false
    /// Where Share on the share-location card reads the position.
    var locator: DeviceLocating = CoreLocationLocator.shared
    /// Whether the guardian is looking at the app, so a share-location card
    /// may answer itself.
    var appActive: () -> Bool = { UIApplication.shared.applicationState == .active }
    /// A share-location card answering itself, or about to: it shows no buttons.
    @Published private(set) var autoSharing = false
    /// The share-location cards this app answered by itself, so a card drawn
    /// again does not send a second share.
    private static var autoShared: Set<String> = []
    /// Whether the card the agent waits on is answered, as stored.
    var answered = false

    private var processor: MessageProcessor?
    private var part: WidgetUIPart?
    private var call: ((String, String, Rome.JSONValue?) async throws -> ConnectReply)?
    private var send: ((String, Rome.JSONValue) async throws -> WidgetEventReply)?
    private var open: (URL) -> Void = { _ in }
    /// Runs the app's own authorization for a device connection's link: nil
    /// for any other link, else whether it was connected.
    private var connectDevice: (URL) async -> Bool? = { _ in nil }
    /// Only the newest read writes the data: a slow read must not land after
    /// a newer one and put back an older value.
    private var reads = 0

    func show(
        _ part: WidgetUIPart,
        call: @escaping (String, String, Rome.JSONValue?) async throws -> ConnectReply,
        press: @escaping (String, Rome.JSONValue) async throws -> WidgetEventReply = { _, _ in throw APIError.notFound },
        open: @escaping (URL) -> Void = { _ in },
        connectDevice: @escaping (URL) async -> Bool? = { _ in nil }
    ) {
        self.open = open
        self.connectDevice = connectDevice
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
        autoSharing = mayShareItself && (locator.permission == .granted || Self.autoShared.contains(autoKey))
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
            guard read == reads, !Task.isCancelled else { return }
            for (pointer, value) in values {
                _ = send("updateDataModel", [
                    "surfaceId": .string(part.toolUseId), "path": .string(pointer), "value": value,
                ])
            }
            failed = false
        } catch {
            // A card whose view went away mid-read keeps its last state.
            if Task.isCancelled { return }
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

    private var autoKey: String { "\(part?.widgetId ?? "")/\(part?.toolUseId ?? "")" }

    /// An open share-location card the agent waits on, which core marked as
    /// one that may answer itself: core marks only a card the guardian's own
    /// message asked for, so an unmarked card always waits for Share.
    private var mayShareItself: Bool {
        guard let part else { return false }
        return part.waits && !answered && !sent && LocationCard.isLocationCard(part)
            && LocationCard.mayAutoShare(part)
    }

    /// Answers an open share-location card at once where the app may already
    /// read the position and the guardian is looking at it; says so where
    /// iOS refuses, leaving Not now; otherwise leaves Share to ask.
    func shareIfAllowed() async {
        guard mayShareItself, !Self.autoShared.contains(autoKey) else { return }
        switch locator.permission {
        case .granted:
            guard appActive() else { return }
            Self.autoShared.insert(autoKey)
            autoSharing = true
            await press(LocationCard.shareEvent, body: .object(["auto": .bool(true)]), auto: true)
            autoSharing = false
        case .denied:
            autoSharing = false
            sendFailed = true
            refusal = LocationCard.failureText(.denied)
        case .undetermined:
            autoSharing = false
        }
    }

    /// `auto` is a share the card sends itself: a refusal from core then says
    /// nothing, since another client answered first.
    private func press(_ name: String, body: Rome.JSONValue, auto: Bool = false) async {
        // Core decides what every event means; the card only sends it.
        let waits = part?.waits == true
        guard let send, !busy, !(waits && (answered || sent)) else { return }
        busy = true
        defer { busy = false }
        var body = body
        // Share on the share-location card carries the phone's position, read
        // on the press so iOS asks for permission then.
        if name == LocationCard.shareEvent, let part, LocationCard.isLocationCard(part) {
            locating = true
            let read = await locator.currentPosition()
            locating = false
            switch read {
            case .success(let position):
                if case .object(var fields) = body, case .object(let fix) = position.json {
                    fields.merge(fix) { _, new in new }
                    body = .object(fields)
                } else {
                    body = position.json
                }
            case .failure(let failure):
                sendFailed = true
                refusal = LocationCard.failureText(failure)
                return
            }
        }
        do {
            var reply = try await send(name, body)
            // A device connection's link runs the app's own authorization,
            // and the card checks once it is done: core reads the report.
            // The card is busy only while it posts: during the authorization
            // its Not now stays usable, and a card answered meanwhile checks
            // nothing.
            if let url = reply.open {
                busy = false
                let connected = await connectDevice(url)
                if let connected {
                    guard connected, !(waits && (answered || sent)), !busy else { return }
                    busy = true
                    reply = try await send("check", body)
                } else {
                    busy = true
                }
            }
            // A link the reply names opens; a card core says is answered is
            // sent, and any other card reads its data again, and that read
            // says whether the card's data failed.
            sendFailed = false
            refusal = nil
            failed = false
            if let url = reply.open { open(url) }
            if waits && reply.answered {
                sent = true
                if auto, let meters = body["accuracy"]?.number {
                    autoSent = .object(["status": .string("shared"), "accuracyMeters": .number(meters.rounded()), "auto": .bool(true)])
                }
            } else { await load() }
        } catch {
            if auto { return }
            // Answered already, by another press or client: nothing failed.
            if waits, case APIError.server(400, let message?) = error, message.contains("already answered") {
                sent = true
                return
            }
            sendFailed = true
            if case APIError.server(_, let message?) = error, !message.isEmpty { refusal = message } else { refusal = nil }
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
