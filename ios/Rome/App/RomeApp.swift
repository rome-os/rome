import SwiftUI

@main
struct RomeApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.launch() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .background: model.workspace?.backend.events.pause()
                    case .active: model.workspace?.backend.events.resume()
                    default: break
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            if model.phase == .ready, let workspace = model.workspace {
                MainShell(workspace: workspace)
                    .id(ObjectIdentifier(workspace))
                    .transition(.opacity)
            } else {
                LoginView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: model.phase == .ready)
        .tint(Palette.primary)
        // Past this size the floating headers and cards stop fitting a phone.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        #if DEBUG
        .modifier(DynamicTypeOverride(size: model.dynamicTypeOverride))
        #endif
    }
}

#if DEBUG
/// Forces a text size only when the snapshot runner asks for one.
private struct DynamicTypeOverride: ViewModifier {
    let size: DynamicTypeSize?

    func body(content: Content) -> some View {
        if let size {
            content.dynamicTypeSize(size)
        } else {
            content
        }
    }
}
#endif
