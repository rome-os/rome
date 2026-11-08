import SwiftUI
import WebKit

/// One app full screen: the instance's own full-screen page for it, in a
/// web view that holds only the instance's session and follows the app's
/// look and language.
struct AppWebScreen: View {
    let workspace: Workspace
    let app: InstalledApp
    /// A page of the instance a chat linked to, shown in place of the app's own.
    var pageURL: URL? = nil

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var progress: Double = 0
    @State private var failed = false
    @State private var reloads = 0

    /// The instance's origin; nil for demo data, which shows a sample page.
    private var origin: URL? { workspace.backend.origin }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack(alignment: .top) {
                AppWebView(
                    url: pageURL ?? origin.flatMap { AppLinks.fullURL(origin: $0, app: app) },
                    origin: origin,
                    cookie: workspace.backend.webSessionCookie(),
                    theme: AppWebView.themeValue(model.appearance.current),
                    style: model.appearance.current.style,
                    language: LanguageSync.code(Bundle.main.preferredLocalizations.first),
                    reloads: reloads,
                    progress: $progress,
                    failed: $failed
                )
                .opacity(failed ? 0 : 1)
                if !failed && progress < 1 {
                    // A thin bar while it loads.
                    GeometryReader { geometry in
                        Rectangle()
                            .fill(Palette.primary)
                            .frame(width: geometry.size.width * max(0.05, progress), height: 2)
                    }
                    .frame(height: 2)
                    .animation(.easeOut(duration: 0.2), value: progress)
                }
                if failed {
                    CenteredMessage(title: "Could not open the app", detail: "Check the network and try again", actionTitle: "Try again") {
                        failed = false
                        reloads += 1
                    }
                    .frame(maxHeight: .infinity)
                }
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBackEnabler())
        // Apps keeps the apps last opened from this phone at its top.
        .task(id: app.id) {
            guard pageURL == nil else { return }
            RecentApps(host: workspace.host).record(app.id)
        }
    }

    private var header: some View {
        HStack {
            GlassCircleButton(accessibilityLabel: "Back", action: { dismiss() }) {
                Image(systemName: "chevron.left").romeFont(17, .semibold)
            }
            PlainHeaderTitle(title: Text(verbatim: app.name))
            Menu {
                Button { failed = false; reloads += 1 } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                if let web = model.webURL, let url = pageURL ?? AppLinks.fullURL(origin: web, app: app) {
                    Button { openURL(url) } label: {
                        Label("Open on the web", systemImage: "safari")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .romeFont(17, .semibold)
                    .foregroundStyle(Palette.fg)
                    .frame(width: 44, height: 44)
                    .glassSurface(Circle(), interactive: true)
            }
            .accessibilityLabel("More")
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 6)
    }
}

/// The web view itself. Its store is its own and kept in memory only, with
/// the instance's session cookie and nothing else; a link to any other site
/// opens in Safari.
struct AppWebView: UIViewRepresentable {
    let url: URL?
    let origin: URL?
    let cookie: HTTPCookie?
    /// `light`, `dark` or `system`, as the dashboard stores it.
    let theme: String
    let style: UIUserInterfaceStyle
    /// `en` or `zh-CN`, as the dashboard names it.
    let language: String
    let reloads: Int
    @Binding var progress: Double
    @Binding var failed: Bool

    static func themeValue(_ appearance: Appearance) -> String {
        switch appearance {
        case .automatic: return "system"
        case .light: return "light"
        case .dark: return "dark"
        }
    }

    /// Set before the page runs, so it opens in the app's look and language.
    static func settingsScript(theme: String, language: String) -> String {
        """
        try {
          localStorage.setItem("rome-theme", "\(theme)");
          localStorage.setItem("rome.lang", "\(language)");
        } catch (e) {}
        """
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.settingsScript(theme: theme, language: language),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.overrideUserInterfaceStyle = style
        view.isOpaque = false
        view.backgroundColor = .clear
        view.allowsBackForwardNavigationGestures = false
        context.coordinator.observe(view)
        context.coordinator.reloads = reloads
        load(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        view.overrideUserInterfaceStyle = style
        if context.coordinator.reloads != reloads {
            context.coordinator.reloads = reloads
            if view.url == nil { load(view) } else { view.reload() }
        }
    }

    private func load(_ view: WKWebView) {
        guard let url else {
            view.loadHTMLString(DemoApp.html, baseURL: nil)
            return
        }
        var request = URLRequest(url: url)
        request.setValue(language == "zh-CN" ? "zh-CN,zh;q=0.9" : "en", forHTTPHeaderField: "Accept-Language")
        if let cookie {
            view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { view.load(request) }
        } else {
            view.load(request)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: AppWebView
        var reloads = 0
        private var progressWatch: NSKeyValueObservation?

        init(_ parent: AppWebView) { self.parent = parent }

        func observe(_ view: WKWebView) {
            progressWatch = view.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                let value = view.estimatedProgress
                DispatchQueue.main.async { self?.parent.progress = value }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url, let origin = parent.origin else { return .allow }
            if AppLinks.staysInApp(url, origin: origin) { return .allow }
            // Another site, in a frame of the page: the cookie is the
            // instance's alone, so a frame elsewhere never sees it.
            if action.targetFrame?.isMainFrame == false { return .allow }
            await UIApplication.shared.open(url)
            return .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // A link that asks for a new window: the instance's own stay here.
            if let url = action.request.url {
                if let origin = parent.origin, AppLinks.staysInApp(url, origin: origin) {
                    webView.load(action.request)
                } else {
                    UIApplication.shared.open(url)
                }
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.progress = 1
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        private func fail(_ error: Error) {
            // A link sent to Safari cancels its navigation: not a failure.
            if (error as NSError).code == NSURLErrorCancelled { return }
            parent.failed = true
            parent.progress = 1
        }
    }
}

/// Demo data's stand-in for an app's page.
enum DemoApp {
    static let html = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
    :root { color-scheme: light dark; --bg:#F4F3EF; --card:#fff; --fg:#1A130F; --sub:#7A6857; --accent:#D86F4C; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0B0907; --card:#191513; --fg:#F4F3EF; --sub:#B0A294; } }
    body { margin:0; padding:20px; background:var(--bg); color:var(--fg); font:16px -apple-system, system-ui; }
    h1 { font-size:24px; margin:8px 0 4px; } p { color:var(--sub); margin:0 0 18px; }
    .row { display:flex; align-items:center; gap:12px; background:var(--card); border-radius:14px; padding:14px 16px; margin-bottom:10px; }
    .dot { width:22px; height:22px; border-radius:11px; border:2px solid var(--accent); }
    .done .dot { background:var(--accent); } .days { margin-left:auto; color:var(--sub); font-size:14px; }
    </style></head><body>
    <h1>Habits</h1><p>Three days in a row. Keep going.</p>
    <div class="row done"><div class="dot"></div>Read 20 pages<span class="days">5 days</span></div>
    <div class="row done"><div class="dot"></div>Walk 6,000 steps<span class="days">3 days</span></div>
    <div class="row"><div class="dot"></div>No phone after 23:00<span class="days">1 day</span></div>
    </body></html>
    """
}
