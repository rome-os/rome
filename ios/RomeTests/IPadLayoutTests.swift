import SwiftUI
import Testing
@testable import Rome

/// An iPad's regular width puts the drawer beside the page; a phone, or a
/// narrow iPad window, keeps the drawer that slides out.
@MainActor
@Suite struct IPadLayoutTests {
    @Test func onlyARegularWidthUsesTheSidebar() {
        #expect(MainShell.usesSidebar(.regular))
        #expect(!MainShell.usesSidebar(.compact))
        #expect(!MainShell.usesSidebar(nil))
    }

    @Test func aConversationColumnStopsAtTheReadableWidth() {
        #expect(Metrics.column(393) == 393)
        #expect(Metrics.column(1032) == Metrics.readableWidth)
    }

    @Test func phonesKeepFourAppColumnsAndAnIPadAddsMore() {
        // iPhone 17e to iPhone 18 Pro Max: four, three at accessibility sizes.
        for width in [375.0, 393, 402, 440] as [CGFloat] {
            #expect(AppGrid.columns(width: width, accessibility: false) == 4, "\(width)")
            #expect(AppGrid.columns(width: width, accessibility: true) == 3, "\(width)")
        }
        // An iPad's page beside the sidebar has room for more.
        #expect(AppGrid.columns(width: 714, accessibility: false) == 6)
        #expect(AppGrid.columns(width: 1024, accessibility: false) == 9)
        #expect(AppGrid.columns(width: 1024, accessibility: true) == 7)
    }
}

/// An iPad window resized across compact and regular (Split View, Stage
/// Manager) keeps the page's stack, and with it the open page and its state:
/// the shell changes frames, never the view tree.
@MainActor
@Suite struct ShellResizeTests {
    @Test func thePageStackSurvivesASizeClassChange() async throws {
        let workspace = Workspace(backend: DemoBackend(variant: .full), instanceName: "T", host: "t", accountLabel: "t", drafts: DraftStore(root: FileManager.default.temporaryDirectory.appending(path: "rome-resize-\(UUID().uuidString)/Drafts"), instance: "t"))
        defer { workspace.stop() }
        let host = UIHostingController(rootView: MainShell(workspace: workspace).environment(AppModel()))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1194, height: 834)
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }

        var stacks: [UINavigationController] = []
        for sizeClass in [UIUserInterfaceSizeClass.regular, .compact, .regular] {
            host.traitOverrides.horizontalSizeClass = sizeClass
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(400))
            stacks.append(try #require(Self.navigation(in: host)))
        }
        #expect(stacks[0] === stacks[1])
        #expect(stacks[1] === stacks[2])
    }

    private static func navigation(in controller: UIViewController) -> UINavigationController? {
        if let navigation = controller as? UINavigationController { return navigation }
        for child in controller.children {
            if let navigation = navigation(in: child) { return navigation }
        }
        return nil
    }
}
