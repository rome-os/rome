import QuickLook
import SwiftUI

/// A file link tapped in a chat, for `linkedFileViewer`: the file, or nil for
/// one the phone cannot open.
struct LinkedFileRequest: Identifiable, Equatable {
    let id = UUID()
    let file: LinkedFile?
}

extension View {
    /// Opens the file set in `request` over this view: downloaded with the
    /// session, then shown in Quick Look, whose Share button sends or saves it,
    /// or straight in the share sheet when Quick Look cannot show it. A file
    /// that fails, or that no route serves, gets a short notice at the top.
    /// A project or memory path that names a folder goes to `openPage` with
    /// the dashboard's page for it. `top` is how far below the view's top
    /// edge the notice sits.
    func linkedFileViewer(backend: RomeBackend, request: Binding<LinkedFileRequest?>, top: CGFloat = 58, openPage: @escaping (URL) -> Void) -> some View {
        modifier(LinkedFileViewer(backend: backend, request: request, top: top, openPage: openPage))
    }
}

private struct LinkedFileViewer: ViewModifier {
    let backend: RomeBackend
    @Binding var request: LinkedFileRequest?
    let top: CGFloat
    let openPage: (URL) -> Void

    @State private var preview: URL?
    @State private var sharing: SharedFile?
    @State private var notice: String?
    @State private var loading = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if loading {
                    // From the tap until Quick Look shows: a large file takes a while.
                    TopBanner(kind: .info, text: String(localized: "Loading…"))
                        .readableColumn()
                        .padding(.top, top)
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else if let notice {
                    TopBanner(kind: .error, text: notice)
                        .readableColumn()
                        .padding(.top, top)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .task(id: notice) {
                            try? await Task.sleep(for: .seconds(3))
                            if self.notice == notice { self.notice = nil }
                        }
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: notice)
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: loading)
            .quickLookPreview($preview)
            .onChange(of: preview) { old, new in
                if new == nil, let old { try? FileManager.default.removeItem(at: old.deletingLastPathComponent()) }
            }
            .sheet(item: $sharing) { shared in
                ActivitySheet(items: [shared.url])
                    .presentationDetents([.medium, .large])
            }
            .onChange(of: request) { _, asked in
                guard let asked else { return }
                request = nil
                open(asked.file)
            }
    }

    private func open(_ file: LinkedFile?) {
        guard let file else {
            notice = String(localized: "This file cannot be opened here.")
            return
        }
        // A second tap while the first downloads opens nothing more.
        guard !loading else { return }
        loading = true
        Task {
            defer { loading = false }
            do {
                // An instance that cannot say what it is gets the download tried.
                switch (try? await backend.linkedFileKind(file)) ?? .file {
                case .folder:
                    if let page = file.page { openPage(page) } else { notice = String(localized: "This file cannot be opened here.") }
                    return
                case .missing:
                    throw APIError.notFound
                case .file:
                    break
                }
                let data = try await backend.linkedFile(file)
                guard let url = AgentOutputsView.write(data, name: file.name) else { throw APIError.network }
                if AgentOutputsView.quickLookReads(url) {
                    preview = url
                } else {
                    sharing = SharedFile(url: url)
                }
            } catch {
                notice = switch error as? APIError {
                case .tooLarge: String(localized: "Too large to open on this phone.")
                case .notFound: String(localized: "Moved or deleted")
                default: String(localized: "Failed to load the file")
                }
            }
        }
    }
}
