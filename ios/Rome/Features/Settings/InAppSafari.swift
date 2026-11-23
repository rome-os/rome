import SafariServices
import SwiftUI

/// A web page in Safari inside the app: the guardian's Safari sign-ins and
/// passwords, with Rome kept in front. Done closes it.
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
