import CoreGraphics
import Foundation

enum PermissionStep: String, CaseIterable {
    case accessibility
    case screenRecording = "screen-recording"

    var title: HelperLocale.Text {
        title(macOSMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
    }

    func title(macOSMajor: Int) -> HelperLocale.Text {
        switch self {
        case .accessibility:
            return macOSMajor >= 27 ? .setupDeviceControl : .setupAccessibility
        case .screenRecording:
            return macOSMajor >= 14 ? .setupScreenAndAudioRecording : .setupScreenRecording
        }
    }

    var settingsURL: URL {
        let pane = self == .accessibility ? "Accessibility" : "ScreenCapture"
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_\(pane)")!
    }
}

struct PermissionSetupRequest {
    let step: PermissionStep?
    let locale: HelperLocale

    init(_ arguments: [String], preferred: [String]) throws {
        if arguments.isEmpty {
            step = nil
            locale = resolveLocale(requested: nil, preferred: preferred)
            return
        }
        var args = arguments.makeIterator()
        guard args.next() == "--setup-permissions" else { throw Failure("invalid_request") }
        var pane: String?
        var tag: String?
        while let arg = args.next() {
            if arg == "--locale" {
                guard tag == nil, let value = args.next(), !value.isEmpty, !value.hasPrefix("-") else {
                    throw Failure("invalid_request")
                }
                tag = value
            } else {
                guard pane == nil, arg == "all" || PermissionStep(rawValue: arg) != nil else {
                    throw Failure("invalid_request")
                }
                pane = arg
            }
        }
        step = pane.flatMap(PermissionStep.init(rawValue:))
        locale = resolveLocale(requested: tag, preferred: preferred)
    }
}

struct PermissionSetupState {
    private(set) var step: PermissionStep?
    private(set) var granted: Set<PermissionStep>
    private var pendingPrompt: PermissionStep?

    init(step requested: PermissionStep?, granted: Set<PermissionStep>) {
        self.granted = granted
        enter(requested ?? firstMissing)
    }

    private var firstMissing: PermissionStep? {
        PermissionStep.allCases.first { !granted.contains($0) }
    }

    mutating func enter(_ requested: PermissionStep?) {
        let next = firstMissing == nil ? nil : requested
        guard step != next else { return }
        step = next
        pendingPrompt = next.flatMap { granted.contains($0) ? nil : $0 }
    }

    mutating func update(_ grants: Set<PermissionStep>) {
        let justGranted = step.map { !granted.contains($0) && grants.contains($0) } ?? false
        granted = grants
        if justGranted || step == nil || firstMissing == nil { enter(firstMissing) }
    }

    mutating func takePrompt() -> PermissionStep? {
        defer { pendingPrompt = nil }
        return pendingPrompt
    }
}

func dockPermissionPanel(size: CGSize, settings: CGRect?, visible: CGRect) -> CGPoint {
    let gap: CGFloat = 12
    func clamp(_ anchor: CGPoint) -> CGPoint {
        CGPoint(x: min(max(anchor.x, visible.minX), max(visible.minX, visible.maxX - size.width)),
                y: min(max(anchor.y, visible.minY), max(visible.minY, visible.maxY - size.height)))
    }
    guard let settings else {
        return clamp(CGPoint(x: visible.maxX - size.width - gap, y: visible.maxY - size.height - gap))
    }
    let top = settings.maxY - size.height
    let anchors = [
        CGPoint(x: settings.maxX + gap, y: top),
        CGPoint(x: settings.minX - size.width - gap, y: top),
        CGPoint(x: settings.maxX - size.width, y: settings.minY - size.height - gap),
    ]
    for anchor in anchors {
        let frame = CGRect(origin: anchor, size: size)
        if visible.contains(frame) { return anchor }
    }
    return anchors.map(clamp).min { a, b in
        func overlap(_ origin: CGPoint) -> CGFloat {
            let intersection = CGRect(origin: origin, size: size).intersection(settings)
            return intersection.isNull ? 0 : intersection.width * intersection.height
        }
        return overlap(a) < overlap(b)
    } ?? clamp(anchors[0])
}
