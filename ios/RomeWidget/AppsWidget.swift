import AppIntents
import SwiftUI
import WidgetKit

@main
struct RomeWidgets: WidgetBundle {
    var body: some Widget {
        AppsWidget()
    }
}

/// The guardian's apps on the home screen, as the Apps page shows them: the
/// picked ones first, then the ones opened last.
struct AppsWidget: Widget {
    static let kind = AppShelfStore.widgetKind

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: ChooseAppsIntent.self, provider: AppsProvider()) { entry in
            AppsWidgetView(entry: entry)
        }
        .configurationDisplayName("Apps")
        .description("Open your Rome apps from the home screen.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: Configuration

/// "Edit Widget": which apps come first.
struct ChooseAppsIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Choose apps"
    static let description = IntentDescription("Pick the apps and shortcuts to show. Spots left over show the apps you opened last.")

    // The widget's four spots (`WidgetSlots.small`).
    @Parameter(title: "Apps", size: [.systemSmall: 4])
    var apps: [ShelfAppEntity]?
}

/// An installed app or a built-in shortcut, for the picker.
struct ShelfAppEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "App"
    static let defaultQuery = ShelfAppQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ShelfAppQuery: EntityQuery {
    func entities(for identifiers: [ShelfAppEntity.ID]) async throws -> [ShelfAppEntity] {
        let apps = AppShelfStore.shared?.read()?.apps ?? []
        return identifiers.compactMap { id in
            if let shortcut = WidgetShortcut(rawValue: id) {
                return ShelfAppEntity(id: id, name: String(localized: shortcut.title))
            }
            return apps.first { $0.id == id }.map { ShelfAppEntity(id: $0.id, name: $0.name) }
        }
    }

    func suggestedEntities() async throws -> [ShelfAppEntity] {
        let shortcuts = WidgetShortcut.allCases.map { ShelfAppEntity(id: $0.rawValue, name: String(localized: $0.title)) }
        let apps = (AppShelfStore.shared?.read()?.apps ?? []).map { ShelfAppEntity(id: $0.id, name: $0.name) }
        return shortcuts + apps
    }
}

// MARK: Timeline

struct AppsEntry: TimelineEntry {
    let date: Date
    let instanceId: String?
    let slots: [WidgetSlot]
    /// Icon files by app id, read when the entry is made.
    let icons: [String: UIImage]
}

struct AppsProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> AppsEntry {
        AppsEntry(date: .now, instanceId: nil, slots: [], icons: [:])
    }

    func snapshot(for configuration: ChooseAppsIntent, in context: Context) async -> AppsEntry {
        entry(for: configuration)
    }

    /// One entry: the app reloads the timeline when its list or its recents change.
    func timeline(for configuration: ChooseAppsIntent, in context: Context) async -> Timeline<AppsEntry> {
        Timeline(entries: [entry(for: configuration)], policy: .never)
    }

    private func entry(for configuration: ChooseAppsIntent) -> AppsEntry {
        let store = AppShelfStore.shared
        let shelf = store?.read()
        let slots = WidgetSlots.choose(
            picked: configuration.apps?.map(\.id) ?? [],
            recent: shelf.map { store?.recent(instanceId: $0.instanceId) ?? [] } ?? [],
            apps: shelf?.apps ?? []
        )
        var icons: [String: UIImage] = [:]
        if let store {
            for case .app(let app) in slots where app.hasIcon {
                icons[app.id] = UIImage(contentsOfFile: store.iconURL(app.id).path(percentEncoded: false))
            }
        }
        return AppsEntry(date: .now, instanceId: shelf?.instanceId, slots: slots, icons: icons)
    }
}

// MARK: Views

/// The scheme of this build's links, from the extension's Info.plist.
private let linkScheme = (Bundle.main.object(forInfoDictionaryKey: "RomeURLScheme") as? String) ?? "rome"

struct AppsWidgetView: View {
    let entry: AppsEntry

    var body: some View {
        Group {
            if !entry.slots.isEmpty {
                AppsGrid(instanceId: entry.instanceId, slots: entry.slots, icons: entry.icons)
                    .widgetURL(WidgetLink.apps.url(scheme: linkScheme))
            } else {
                MakeAppButton()
                    .widgetURL(WidgetLink.newApp.url(scheme: linkScheme))
            }
        }
        .containerBackground(for: .widget) { WidgetColors.background }
    }
}

/// One or two slots keep the top row, as on a home screen.
private struct AppsGrid: View {
    let instanceId: String?
    let slots: [WidgetSlot]
    let icons: [String: UIImage]

    private var rows: [[WidgetSlot]] {
        stride(from: 0, to: slots.count, by: 2).map { Array(slots[$0..<min($0 + 2, slots.count)]) }
    }

    /// Two rows of icon and name fill the small family's height.
    private static let iconSize: CGFloat = 46

    var body: some View {
        VStack(spacing: 8) {
            ForEach(0..<2, id: \.self) { index in
                HStack(alignment: .top, spacing: 8) {
                    ForEach(0..<2, id: \.self) { column in
                        if index < rows.count, column < rows[index].count {
                            cell(rows[index][column])
                        } else {
                            // An empty spot keeps the grid's shape.
                            Color.clear.frame(maxWidth: .infinity).frame(height: Self.iconSize + 16)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func cell(_ slot: WidgetSlot) -> some View {
        switch slot {
        case .app(let app):
            if let instanceId { appCell(app, instanceId: instanceId) }
        case .shortcut(let shortcut):
            Link(destination: shortcut.link.url(scheme: linkScheme)) {
                VStack(spacing: 4) {
                    WidgetShortcutIcon(shortcut: shortcut, size: Self.iconSize)
                    Text(String(localized: shortcut.title))
                        .romeFont(11)
                        .foregroundStyle(WidgetColors.label)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                // Match the fixed-size app tiles in this home-screen grid.
                .dynamicTypeSize(.large)
                .frame(maxWidth: .infinity)
            }
        }
    }

    @ViewBuilder
    private func appCell(_ app: ShelfApp, instanceId: String) -> some View {
        let content = VStack(spacing: 4) {
            WidgetAppIcon(app: app, image: icons[app.id], size: Self.iconSize)
            // One line, cut at the end: a small widget's half is about 60 pt wide.
            Text(verbatim: app.name)
                .font(.system(size: 11))
                .foregroundStyle(WidgetColors.label)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .opacity(app.opens ? 1 : 0.4)
        .frame(maxWidth: .infinity)
        // A stopped app falls through to the widget's own link: the Apps page.
        if app.opens {
            Link(destination: WidgetLink.app(instanceId: instanceId, appId: app.id).url(scheme: linkScheme)) { content }
        } else {
            content
        }
    }
}

private struct WidgetShortcutIcon: View {
    let shortcut: WidgetShortcut
    let size: CGFloat

    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        Image(systemName: shortcut.systemImage)
            .romeFont(size * 0.45, .medium)
            .foregroundStyle(renderingMode == .fullColor ? WidgetColors.label : .white)
            .widgetAccentable()
            .frame(width: size, height: size)
            .background(
                renderingMode == .fullColor ? WidgetColors.plate : Color.white.opacity(0.18),
                in: RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
            )
    }
}

/// The app's icon, or its letter tile in the Apps page's color for it.
private struct WidgetAppIcon: View {
    let app: ShelfApp
    let image: UIImage?
    let size: CGFloat

    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        Group {
            if let image {
                icon(Image(uiImage: image).resizable())
            } else if renderingMode == .fullColor {
                letter.background(AppTile.color(for: app.name))
            } else {
                // Tinted and clear home screens: the tile is a soft plate and
                // the letter takes the accent.
                letter.background(Color.white.opacity(0.18))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
    }

    private var letter: some View {
        Text(verbatim: AppTile.letter(for: app.name))
            .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .widgetAccentable()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func icon(_ image: Image) -> some View {
        if #available(iOS 18.0, *) {
            image.widgetAccentedRenderingMode(.accentedDesaturated)
        } else {
            image
        }
    }
}

/// Signed out, or no apps yet: one way to make the first.
private struct MakeAppButton: View {
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        VStack(spacing: 8) {
            // Tinted and clear home screens: a soft plate, and only the plus
            // takes the accent, as on the letter tiles.
            Image(systemName: "plus")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(renderingMode == .fullColor ? WidgetColors.label : .white)
                .widgetAccentable()
                .frame(width: 46, height: 46)
                .background(
                    renderingMode == .fullColor ? WidgetColors.plate : Color.white.opacity(0.18),
                    in: RoundedRectangle(cornerRadius: 46 * 0.225, style: .continuous)
                )
            Text("Make an app")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(WidgetColors.label)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The app's page and text colors (`Palette.bg`, `fg`, `fill`).
private enum WidgetColors {
    static let background = AppTile.dynamic(0xF4F3EF, 0x0B0907)
    static let label = AppTile.dynamic(0x1A130F, 0xF4F3EF)
    static let plate = AppTile.dynamic(0xEFE9E1, 0x272320)
}
