import UIKit
import WebKit

/// An app icon's bytes as an image. Apps ship their icon as SVG (the coding
/// app's authoring guide asks for `assets/icon.svg`), which `UIImage` cannot
/// decode, so an SVG is drawn once by WebKit, as the web dashboard's `<img>`
/// draws it, and kept in memory.
@MainActor
enum AppIconImage {
    private static let cache = NSCache<NSData, UIImage>()

    static func decode(_ data: Data, side: CGFloat) async -> UIImage? {
        if let image = UIImage(data: data) { return image }
        guard isSVG(data) else { return nil }
        let key = data as NSData
        if let cached = cache.object(forKey: key) { return cached }
        guard let image = await SVGRasterizer.shared.image(svg: data, side: side) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// An SVG document, by its first markup: `<svg`, or an XML prolog or
    /// comment before it.
    nonisolated static func isSVG(_ data: Data) -> Bool {
        guard let head = String(data: data.prefix(1024), encoding: .utf8)?.lowercased() else { return false }
        let trimmed = head.drop { $0.isWhitespace || $0 == "\u{feff}" }
        return trimmed.hasPrefix("<svg") || (trimmed.hasPrefix("<") && head.contains("<svg"))
    }
}

/// Draws SVGs in one hidden web view, one at a time. The SVG goes in an
/// `<img>`, where its scripts never run, on a page with JavaScript off and no
/// stored data.
@MainActor
private final class SVGRasterizer: NSObject, WKNavigationDelegate {
    static let shared = SVGRasterizer()

    private var webView: WKWebView?
    private var loaded: CheckedContinuation<Bool, Never>?
    /// The draw in progress; the next one waits for it.
    private var current: Task<UIImage?, Never>?

    func image(svg: Data, side: CGFloat) async -> UIImage? {
        let previous = current
        let task = Task<UIImage?, Never> { @MainActor in
            _ = await previous?.value
            return await self.draw(svg: svg, side: side)
        }
        current = task
        return await task.value
    }

    private func draw(svg: Data, side: CGFloat) async -> UIImage? {
        let view = webView ?? makeWebView()
        // WebKit draws only a view inside a window; it sits off screen.
        if view.window == nil, let window = Self.keyWindow() {
            view.frame = CGRect(x: -side * 4, y: 0, width: side, height: side)
            window.addSubview(view)
        }
        view.frame.size = CGSize(width: side, height: side)
        let source = "data:image/svg+xml;base64,\(svg.base64EncodedString())"
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=\(Int(side)),initial-scale=1">\
        <style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:\(Int(side))px;height:\(Int(side))px}</style>\
        </head><body><img src="\(source)"></body></html>
        """
        let finished = await withCheckedContinuation { continuation in
            loaded = continuation
            view.loadHTMLString(html, baseURL: nil)
        }
        guard finished else { return nil }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: 0, y: 0, width: side, height: side)
        configuration.afterScreenUpdates = true
        return try? await view.takeSnapshot(configuration: configuration)
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        // In a window, the page would sit below the safe area and draw shifted.
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.isScrollEnabled = false
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.navigationDelegate = self
        webView = view
        return view
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(false)
    }

    private func finish(_ ok: Bool) {
        loaded?.resume(returning: ok)
        loaded = nil
    }
}
