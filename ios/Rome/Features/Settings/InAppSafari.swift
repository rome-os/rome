import SafariServices
import SwiftUI

/// A web page in Safari inside the app, with Rome kept in front. It keeps
/// its own cookies, not Safari's: the guardian signs in there, with saved
/// passwords offered by AutoFill. Done closes it.
struct InAppSafari: UIViewControllerRepresentable {
    struct Page: Identifiable {
        let url: URL
        var id: String { url.absoluteString }
    }

    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .done
        controller.preferredControlTintColor = UIColor(Palette.primary)
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
