import ApplicationServices
import CoreGraphics
import Foundation

struct WindowAXNode {
    let ref: String
    let element: AXUIElement
    let parentRef: String?
    let role: String
    let identifier: String
    let title: String
    let value: String
    let frame: CGRect
    let enabled: Bool
    let actions: [String]
    let valueSettable: Bool
    var metadata: [String: Any]
}

struct WindowAXSnapshot {
    let version: Int
    let nodes: [WindowAXNode]
    let region: WindowAXRegion?
    // True covers the tree structure, not the availability of every optional attribute.
    let complete: Bool
    let diagnostics: [String: Any]
    let delta: [String: Any]
}

struct WindowAXRegion: Equatable {
    let bounds: CGRect
    let pixels: CGRect
    let fromEnd: Bool

    func includes(_ frame: CGRect) -> Bool {
        frame.isNull || frame.intersects(bounds)
    }
}

// Calls on one instance must share its window's serialized execution lane.
final class WindowAXState {
    static let maximumDepth = 32
    private static let maximumRegionDepth = 48
    private static let maximumNodes = 512
    private static let domIdentifier = "AXDOMIdentifier"
    private struct Registry {
        private struct Entry {
            let element: CFTypeRef
            let ref: String
        }
        private var buckets: [CFHashCode: [Entry]] = [:]
        var count: Int { buckets.values.reduce(0) { $0 + $1.count } }

        mutating func reference(for element: CFTypeRef) -> String {
            reference(for: element, bucket: CFHash(element))
        }

        mutating func reference(for element: CFTypeRef, bucket: CFHashCode) -> String {
            if let prior = buckets[bucket]?.first(where: { CFEqual($0.element, element) }) { return prior.ref }
            let ref = UUID().uuidString.lowercased()
            buckets[bucket, default: []].append(Entry(element: element, ref: ref))
            return ref
        }

        mutating func retain(_ refs: Set<String>) {
            for key in Array(buckets.keys) {
                let remaining = buckets[key]!.filter { refs.contains($0.ref) }
                if remaining.isEmpty { buckets.removeValue(forKey: key) } else { buckets[key] = remaining }
            }
        }

        mutating func retire(_ elements: [CFTypeRef]) -> Set<String> {
            var removed: Set<String> = []
            for key in Array(buckets.keys) {
                let remaining = buckets[key]!.filter { entry in
                    if elements.contains(where: { CFEqual($0, entry.element) }) { removed.insert(entry.ref); return false }
                    return true
                }
                if remaining.isEmpty { buckets.removeValue(forKey: key) } else { buckets[key] = remaining }
            }
            return removed
        }
    }

    private struct Revision {
        let version: Int
        let complete: Bool
        let records: [[String: Any]]
        let byRef: [String: [String: Any]]
    }

    private struct Attributes {
        var values: [String: CFTypeRef] = [:]
        var failed: Set<String> = []
    }

    private var registry = Registry()
    private var latest: [String: WindowAXNode] = [:]
    private var prior: Revision?
    private var root: AXUIElement?
    private var owner: pid_t?
    private var region: WindowAXRegion?
    private var version = 0
    private var lineage = UUID().uuidString.lowercased()

    init() {}

    func node(ref: String) -> WindowAXNode? { latest[ref] }

    // A destroyed accessibility object must never regain its former reference if its AX identity is recycled.
    func retire(_ elements: [AXUIElement]) {
        for ref in registry.retire(elements) { latest.removeValue(forKey: ref) }
    }

    func invalidate() {
        registry = Registry()
        latest = [:]
        prior = nil
        root = nil
        owner = nil
        region = nil
        lineage = UUID().uuidString.lowercased()
    }

    private func prepare(root: AXUIElement, pid: pid_t, region: WindowAXRegion?) {
        if owner != pid || self.root.map({ !CFEqual($0, root) }) != false || self.region != region || registry.count > 1024 {
            invalidate()
            owner = pid
            self.root = root
            self.region = region
        }
    }

    // The caller supplies an identity-checked window root and invalidates this state when its process identity changes.
    // Frames are global points. A failed read revokes all node lookups until another snapshot completes.
    func read(root: AXUIElement, pid: pid_t, bounds: CGRect, region: WindowAXRegion? = nil, check: () throws -> Void) throws -> WindowAXSnapshot {
        latest = [:]
        guard pid > 0, CFGetTypeID(root) == AXUIElementGetTypeID(), Self.valid(bounds),
              region.map({ Self.valid($0.bounds) }) != false else {
            prior = nil
            throw NativeFailure("window_ax_invalid_root")
        }
        prepare(root: root, pid: pid, region: region)
        do {
            try check()
            var found: pid_t = 0
            guard AXUIElementGetPid(root, &found) == .success, found == pid else {
                throw NativeFailure("window_ax_owner_changed")
            }
            return try withoutActuallyEscaping(check) { checking in
                let reader = Reader(bounds: bounds, region: region, check: checking)
                try reader.locateRegionCenter(root: root, pid: pid)
                try reader.visit(root, parentRef: nil, index: 0, depth: 0, registry: &registry)
                try checking()
                let delta = try append(reader.nodes.map(\.metadata), complete: reader.complete)
                latest = Dictionary(uniqueKeysWithValues: reader.nodes.map { ($0.ref, $0) })
                if reader.complete { registry.retain(Set(latest.keys)) }
                return WindowAXSnapshot(version: version, nodes: reader.nodes, region: region, complete: reader.complete,
                                        diagnostics: reader.diagnostics, delta: delta)
            }
        } catch {
            latest = [:]
            prior = nil
            throw error
        }
    }

    // Refresh returns a new single-node projection without changing the observation or its authorized references.
    // A structurally incomplete refresh throws. Optional errors remain unavailable or truncated in its metadata.
    func refresh(node: WindowAXNode, pid: pid_t, bounds: CGRect, check: () throws -> Void) throws -> WindowAXNode {
        guard pid > 0, owner == pid, Self.valid(bounds),
              let current = latest[node.ref], CFEqual(current.element, node.element), current.parentRef == node.parentRef,
              let index = Self.index(node.metadata, ref: node.ref, parent: node.parentRef),
              Self.index(current.metadata, ref: current.ref, parent: current.parentRef) == index else {
            throw NativeFailure("window_ax_stale_reference")
        }
        try check()
        var found: pid_t = 0
        guard AXUIElementGetPid(node.element, &found) == .success, found == pid else { throw NativeFailure("window_ax_owner_changed") }
        return try usingRegistryCopy { registry in
            try withoutActuallyEscaping(check) { checking in
                let reader = Reader(bounds: bounds, check: checking)
                try reader.visit(node.element, parentRef: node.parentRef, index: index, depth: 0, registry: &registry,
                                 menuAncestor: node.metadata["menuAncestor"] as? Bool == true, descend: false)
                try checking()
                guard reader.complete, reader.nodes.count == 1, let fresh = reader.nodes.first else {
                    throw NativeFailure("window_ax_refresh_incomplete", details: reader.diagnostics)
                }
                guard fresh.ref == node.ref, fresh.parentRef == node.parentRef,
                      Self.index(fresh.metadata, ref: fresh.ref, parent: fresh.parentRef) == index else {
                    throw NativeFailure("window_ax_reference_changed")
                }
                guard AXUIElementGetPid(fresh.element, &found) == .success, found == pid else { throw NativeFailure("window_ax_owner_changed") }
                try checking()
                return fresh
            }
        }
    }

    private func usingRegistryCopy<T>(_ operation: (inout Registry) throws -> T) rethrows -> T {
        var copy = registry
        return try operation(&copy)
    }

    private static func index(_ metadata: [String: Any], ref: String, parent: String?) -> Int? {
        guard metadata["ref"] as? String == ref, let index = metadata["index"] as? Int, index >= 0 else { return nil }
        if let parent {
            guard metadata["parentRef"] as? String == parent else { return nil }
        } else if !(metadata["parentRef"] is NSNull) { return nil }
        return index
    }

    // Full mode replaces the client index with added. Delta mode replaces each added/changed record and removes listed refs.
    // A partial snapshot cannot infer removals and also prevents a delta against that partial baseline.
    private func append(_ records: [[String: Any]], complete: Bool) throws -> [String: Any] {
        guard version < Int.max else { throw NativeFailure("window_ax_version_exhausted") }
        var byRef: [String: [String: Any]] = [:]
        for record in records {
            guard let ref = record["ref"] as? String, byRef[ref] == nil else { throw NativeFailure("window_ax_duplicate_reference") }
            byRef[ref] = record
        }
        version += 1
        let incremental = complete && prior?.complete == true
        let added = incremental ? records.filter { prior!.byRef[$0["ref"] as! String] == nil } : records
        let changed = incremental ? records.filter { record in
            guard let old = prior!.byRef[record["ref"] as! String] else { return false }
            return !NSDictionary(dictionary: old).isEqual(to: record)
        } : []
        let removed = incremental ? prior!.records.reversed().compactMap { record -> String? in
            let ref = record["ref"] as! String
            return byRef[ref] == nil ? ref : nil
        } : []
        let delta: [String: Any] = ["mode": incremental ? "delta" : "full", "lineageId": lineage,
            "baseVersion": incremental ? prior!.version as Any : NSNull(), "version": version, "complete": complete,
            "added": added, "changed": changed, "removed": removed]
        prior = Revision(version: version, complete: complete, records: records, byRef: byRef)
        return delta
    }

    private static func valid(_ bounds: CGRect) -> Bool {
        !bounds.isNull && [bounds.minX, bounds.minY, bounds.width, bounds.height, bounds.maxX, bounds.maxY].allSatisfy(\.isFinite)
            && bounds.size.width > 0 && bounds.size.height > 0
    }

    private static func relativeFrame(_ frame: CGRect, bounds: CGRect) -> [Double] {
        guard valid(frame), valid(bounds) else { return [] }
        let values = [frame.minX - bounds.minX, frame.minY - bounds.minY, frame.width, frame.height].map(Double.init)
        return values.allSatisfy(\.isFinite) ? values : []
    }

    private static func clip(_ text: String, maxBytes: Int, budget: inout Int) -> (text: String, truncated: Bool) {
        let limit = max(0, min(maxBytes, budget))
        var bytes = Array(text.utf8.prefix(limit + 1))
        let truncated = bytes.count > limit
        if truncated { bytes.removeLast() }
        while String(bytes: bytes, encoding: .utf8) == nil { bytes.removeLast() }
        budget -= bytes.count
        return (String(decoding: bytes, as: UTF8.self), truncated)
    }

    private static func optional(_ error: AXError) -> Bool { error == .noValue || error == .attributeUnsupported }

    private static func validateStrings(_ attributes: Attributes) -> Attributes {
        var result = attributes
        for key in [kAXRoleAttribute, kAXSubroleAttribute, kAXIdentifierAttribute, domIdentifier, kAXTitleAttribute, kAXDescriptionAttribute] {
            if let value = result.values[key], value as? String == nil {
                result.values.removeValue(forKey: key)
                result.failed.insert(key)
            }
        }
        return result
    }

    private static func structural(_ failed: Set<String>) -> Bool {
        failed.contains(kAXRoleAttribute) || failed.contains(kAXSubroleAttribute)
    }

    private static func identifier(_ identity: Attributes) -> (text: String, source: String, failed: Bool) {
        for key in [kAXIdentifierAttribute, domIdentifier] {
            if let value = identity.values[key] as? String, !value.isEmpty {
                return (value, key, identity.failed.contains(key))
            }
        }
        return ("", "missing", identity.failed.contains(kAXIdentifierAttribute) || identity.failed.contains(domIdentifier))
    }

    private static func protected(_ identity: Attributes) -> Bool {
        let role = identity.values[kAXRoleAttribute] as? String
        return role == nil || role!.isEmpty || role == "AXSecureTextField"
            || identity.values[kAXSubroleAttribute] as? String == "AXSecureTextField" || identity.failed.contains(kAXSubroleAttribute)
    }

    private static func visibleValue(_ raw: CFTypeRef?, secure: Bool) -> (kind: String, text: String, omitted: Bool) {
        if secure { return ("secure", "", true) }
        guard let raw else { return ("missing", "", true) }
        if let value = raw as? String { return ("string", value, false) }
        if let value = raw as? NSNumber {
            return (CFGetTypeID(value) == CFBooleanGetTypeID() ? "boolean" : "number", value.stringValue, false)
        }
        return ("unsupported", "", true)
    }

    private static func selection(_ range: CFRange) -> [Int]? {
        guard range.location >= 0, range.length >= 0, range.location != kCFNotFound,
              range.location != NSNotFound, range.length != NSNotFound else { return nil }
        let end = range.location.addingReportingOverflow(range.length)
        guard !end.overflow, end.partialValue <= 9_007_199_254_740_991 else { return nil }
        return [range.location, range.length]
    }

    private static func selection(_ raw: CFTypeRef) -> [Int]? {
        guard CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetType(raw as! AXValue) == .cfRange else { return nil }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(raw as! AXValue, .cfRange, &range) else { return nil }
        return selection(range)
    }

    private static func focused(_ raw: CFTypeRef?) -> Bool? {
        guard let raw, CFGetTypeID(raw) == CFBooleanGetTypeID() else { return nil }
        return raw as? Bool
    }

    private static func selectionCandidate(secure: Bool, kind: String, truncated: Bool, range: [Int]?) -> Bool {
        !secure && kind == "string" && !truncated && range != nil
    }

    private final class Reader {
        let bounds: CGRect
        let region: WindowAXRegion?
        let maximumDepth: Int
        let check: () throws -> Void
        let started = ProcessInfo.processInfo.systemUptime
        var nodes: [WindowAXNode] = []
        var complete = true
        private var remaining = 64 * 1024
        private var visited: Set<String> = []
        private var reasons: [String: Int] = [:]
        private var attributeErrors: [String: Int] = [:]
        private var calls = 0
        private var batches = 0
        private var regionCenterAncestors: [AXUIElement] = []

        init(bounds: CGRect, region: WindowAXRegion? = nil, check: @escaping () throws -> Void) {
            self.bounds = bounds; self.region = region; self.check = check
            maximumDepth = region == nil ? WindowAXState.maximumDepth : WindowAXState.maximumRegionDepth
        }

        var diagnostics: [String: Any] {
            ["nodeCount": nodes.count, "ipcCalls": calls, "batchReads": batches, "contentBytes": 64 * 1024 - remaining,
             "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000, "incompleteReasons": reasons, "attributeErrors": attributeErrors,
             "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height].map(Double.init), "freshRead": true]
        }

        func partial(_ reason: String) {
            complete = false
            let key = reasons[reason] != nil || reasons.count < 32 ? reason : "other"
            reasons[key, default: 0] += 1
        }

        func attributeError(_ reason: String) {
            let key = attributeErrors[reason] != nil || attributeErrors.count < 32 ? reason : "other"
            attributeErrors[key, default: 0] += 1
        }

        func text(_ value: String, key: String, limit: Int) -> (text: String, truncated: Bool) {
            let available = remaining
            let result = WindowAXState.clip(value, maxBytes: limit, budget: &remaining)
            if result.truncated {
                if available <= limit { partial("content_budget") } else { attributeError("\(key)_limit") }
            }
            if remaining == 0 { partial("content_budget") }
            return result
        }

        private func ready(_ element: AXUIElement, structural: Bool = true) throws -> Bool {
            try check()
            let seconds = 0.6 - (ProcessInfo.processInfo.systemUptime - started)
            guard seconds >= 0.008 else { partial("time_budget"); return false }
            let error = AXUIElementSetMessagingTimeout(element, Float(min(0.04, seconds)))
            guard error == .success else {
                if structural { partial("timeout_configuration_\(error.rawValue)") }
                else { attributeError("timeout_configuration_\(error.rawValue)") }
                return false
            }
            return true
        }

        private func after() throws {
            try check()
            if ProcessInfo.processInfo.systemUptime - started > 0.6 { partial("time_budget") }
        }

        // A floating control can be painted outside a layout ancestor's AX frame.
        // Only keep ancestors of an application-scoped hit traced back to this window.
        func locateRegionCenter(root: AXUIElement, pid: pid_t) throws {
            guard let region else { return }
            let app = AXUIElementCreateApplication(pid)
            guard try ready(app) else { return }
            var hit: AXUIElement?
            calls += 1
            guard AXUIElementCopyElementAtPosition(app, Float(region.bounds.midX), Float(region.bounds.midY), &hit) == .success,
                  var current = hit else { return }
            var path: [AXUIElement] = []
            let deadline = started + 0.12
            while path.count <= maximumDepth, ProcessInfo.processInfo.systemUptime < deadline {
                if CFEqual(current, root) { regionCenterAncestors = path; return }
                var owner: pid_t = 0
                guard AXUIElementGetPid(current, &owner) == .success, owner == pid,
                      !path.contains(where: { CFEqual($0, current) }), try ready(current) else { return }
                var parent: CFTypeRef?
                calls += 1
                guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                      let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { return }
                path.append(current)
                current = parent as! AXUIElement
            }
        }

        private func attributes(_ element: AXUIElement, _ names: [String]) throws -> Attributes {
            guard try ready(element, structural: WindowAXState.structural(Set(names))) else { return Attributes(failed: Set(names)) }
            calls += 1; batches += 1
            var raw: CFArray?
            let error = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
            try after()
            guard error == .success, let values = raw as? [CFTypeRef], values.count == names.count else {
                attributeError("batch_\(error.rawValue)")
                if WindowAXState.structural(Set(names)) { partial("safety_batch") }
                return Attributes(failed: Set(names))
            }
            var result = Attributes()
            for (name, value) in zip(names, values) {
                if CFGetTypeID(value) == CFNullGetTypeID() { continue }
                if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
                    var attributeError = AXError.success
                    if !AXValueGetValue(value as! AXValue, .axError, &attributeError) || !WindowAXState.optional(attributeError) {
                        result.failed.insert(name); self.attributeError("\(name)_\(attributeError.rawValue)")
                    }
                } else { result.values[name] = value }
            }
            return result
        }

        private func children(_ element: AXUIElement, nodeIndex: Int? = nil) throws -> [(Int, AXUIElement)] {
            guard try ready(element) else { return [] }
            var count: CFIndex = 0
            calls += 1
            let counted = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
            try after()
            guard counted == .success else {
                if !WindowAXState.optional(counted) { partial("children_count_\(counted.rawValue)") }
                return []
            }
            guard count >= 0 else { partial("invalid_children_count"); return [] }
            if let nodeIndex, nodes[nodeIndex].role == "AXGroup" { nodes[nodeIndex].metadata["childCount"] = count }
            let limit = min(count, max(0, WindowAXState.maximumNodes - nodes.count))
            if count > limit { partial("node_budget") }
            guard limit > 0, try ready(element) else { return [] }
            let backwards = region?.fromEnd == true
            let offset = backwards ? count - limit : 0
            var raw: CFArray?
            calls += 1
            let error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, offset, limit, &raw)
            try after()
            guard error == .success, let values = raw as? [CFTypeRef], values.count <= limit else {
                partial("children_read_\(error.rawValue)"); return []
            }
            if values.count < limit { partial("children_changed") }
            var result: [(Int, AXUIElement)] = []
            for (index, value) in values.enumerated() {
                if CFGetTypeID(value) == AXUIElementGetTypeID() { result.append((offset + index, value as! AXUIElement)) }
                else { partial("invalid_child") }
            }
            return backwards ? Array(result.reversed()) : result
        }

        private func hasOverhangingChild(_ element: AXUIElement, identity: Attributes, frame rect: CGRect) throws -> Bool {
            guard let region, identity.values[kAXRoleAttribute] as? String == "AXGroup",
                  !WindowAXState.protected(identity), rect.intersects(bounds),
                  rect.minX < region.bounds.maxX && region.bounds.minX < rect.maxX ||
                  rect.minY < region.bounds.maxY && region.bounds.minY < rect.maxY else { return false }
            for (_, child) in try children(element) {
                let childRect = frame(try attributes(child, [kAXPositionAttribute, kAXSizeAttribute]))
                if !childRect.isNull && childRect.intersects(region.bounds) { return true }
            }
            return false
        }

        private func frame(_ values: Attributes) -> CGRect {
            guard let position = values.values[kAXPositionAttribute], let size = values.values[kAXSizeAttribute] else { return .null }
            var point = CGPoint.zero, dimensions = CGSize.zero
            guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID(),
                  AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else {
                attributeError("invalid_geometry"); return .null
            }
            let rect = CGRect(origin: point, size: dimensions)
            guard WindowAXState.valid(rect), dimensions.width >= 0, dimensions.height >= 0 else {
                if ![point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite) || dimensions.width < 0 || dimensions.height < 0 {
                    attributeError("invalid_geometry")
                }
                return .null
            }
            return rect
        }

        private func actionNames(_ element: AXUIElement) throws -> [String] {
            guard try ready(element, structural: false) else { return [] }
            calls += 1
            var raw: CFArray?
            let error = AXUIElementCopyActionNames(element, &raw)
            try after()
            guard error == .success else {
                if !WindowAXState.optional(error) { attributeError("actions_\(error.rawValue)") }
                return []
            }
            guard let values = raw as? [String] else { attributeError("invalid_actions"); return [] }
            if values.count > 32 { attributeError("action_budget") }
            var names: [String] = []
            for name in Array(Set(values.prefix(32))).sorted() {
                guard !name.isEmpty, !name.contains("\0") else { attributeError("invalid_action"); continue }
                let value = text(name, key: "action", limit: 128)
                if !value.truncated { names.append(value.text) }
            }
            return names
        }

        private func settable(_ element: AXUIElement, attribute: String = kAXValueAttribute) throws -> Bool {
            guard try ready(element, structural: false) else { return false }
            calls += 1
            var value: DarwinBoolean = false
            let error = AXUIElementIsAttributeSettable(element, attribute as CFString, &value)
            try after()
            guard error == .success else {
                if !WindowAXState.optional(error) { attributeError("\(attribute)_settable_\(error.rawValue)") }
                return false
            }
            return value.boolValue
        }

        func visit(_ element: AXUIElement, parentRef: String?, index: Int, depth: Int, registry: inout Registry,
                   menuAncestor: Bool = false, descend: Bool = true) throws {
            try check()
            guard nodes.count < WindowAXState.maximumNodes, depth <= maximumDepth, remaining > 0 else {
                partial(depth > maximumDepth ? "depth_budget" : remaining == 0 ? "content_budget" : "node_budget"); return
            }
            guard try ready(element) else { return }
            let rawIdentity = try attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXIdentifierAttribute,
                WindowAXState.domIdentifier, kAXTitleAttribute, kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute])
            let rect = frame(rawIdentity)
            let identity = WindowAXState.validateStrings(rawIdentity)
            let ancestorOnly = depth > 0 && region?.includes(rect) == false
            if ancestorOnly && !regionCenterAncestors.contains(where: { CFEqual($0, element) }) {
                // A floating toolbar can extend beyond its group while the AX hit belongs to the page behind it.
                guard try hasOverhangingChild(element, identity: identity, frame: rect) else { return }
            }
            let ref = registry.reference(for: element)
            guard visited.insert(ref).inserted else { partial("duplicate_element"); return }
            for key in identity.failed.subtracting(rawIdentity.failed) { attributeError("\(key)_type") }
            if WindowAXState.structural(identity.failed) { partial("security_identity") }
            let rawRole = identity.values[kAXRoleAttribute] as? String
            if rawRole == nil || rawRole!.isEmpty { partial("role_unavailable") }
            let secure = WindowAXState.protected(identity)
            let contents = secure || ancestorOnly ? Attributes() : try attributes(element, [kAXValueAttribute, kAXSelectedTextRangeAttribute, kAXFocusedAttribute])
            let visible = WindowAXState.visibleValue(contents.values[kAXValueAttribute], secure: secure)
            if visible.kind == "unsupported" { attributeError("value_type") }
            let role = text(rawRole ?? "", key: kAXRoleAttribute, limit: 128)
            let identifierValue = WindowAXState.identifier(identity)
            let identifier = text(identifierValue.text, key: identifierValue.source, limit: 256)
            let title = text((identity.values[kAXTitleAttribute] as? String)
                ?? (identity.values[kAXDescriptionAttribute] as? String) ?? "", key: kAXTitleAttribute, limit: 512)
            let value = text(visible.text, key: kAXValueAttribute, limit: 16_384)
            let roleTruncated = role.truncated || rawRole == nil || rawRole!.isEmpty || identity.failed.contains(kAXRoleAttribute)
            let identifierTruncated = identifier.truncated || identifierValue.failed
            let titleTruncated = title.truncated || identity.failed.contains(kAXTitleAttribute)
                || (identity.values[kAXTitleAttribute] == nil && identity.failed.contains(kAXDescriptionAttribute))
            let valueTruncated = value.truncated || visible.omitted || contents.failed.contains(kAXValueAttribute)
            let rawEnabled = identity.values[kAXEnabledAttribute]
            let enabledValid = rawEnabled == nil || CFGetTypeID(rawEnabled!) == CFBooleanGetTypeID()
            let enabled = enabledValid && !identity.failed.contains(kAXEnabledAttribute) && (rawEnabled as? Bool != false)
            if !enabledValid { attributeError("invalid_enabled") }
            let canAct = enabled && !secure && !roleTruncated && !ancestorOnly
            let actions = canAct ? try actionNames(element) : []
            let usableValue = ["string", "number", "boolean"].contains(visible.kind)
                || visible.kind == "missing" && ["AXTextField", "AXTextArea", "AXComboBox"].contains(role.text)
            let valueSettable = canAct && !value.truncated && !contents.failed.contains(kAXValueAttribute) && usableValue
                ? try settable(element) : false
            var selected: [Int]?
            if let raw = contents.values[kAXSelectedTextRangeAttribute] {
                selected = WindowAXState.selection(raw)
                if selected == nil { attributeError("invalid_selected_text_range") }
            }
            let focused = WindowAXState.focused(contents.values[kAXFocusedAttribute])
            if contents.values[kAXFocusedAttribute] != nil && focused == nil { attributeError("invalid_focused") }
            let selectionSettable = WindowAXState.selectionCandidate(secure: secure, kind: visible.kind, truncated: valueTruncated, range: selected)
                ? try settable(element, attribute: kAXSelectedTextRangeAttribute) : false
            let local = WindowAXState.relativeFrame(rect, bounds: bounds)
            if !rect.isNull && local.isEmpty { attributeError("invalid_local_geometry") }
            var metadata: [String: Any] = ["ref": ref, "parentRef": parentRef as Any? ?? NSNull(), "index": index,
                "role": role.text, "identifier": identifier.text, "identifierSource": identifierValue.source, "title": title.text,
                "roleTruncated": roleTruncated, "identifierTruncated": identifierTruncated,
                "titleTruncated": titleTruncated, "valueTruncated": valueTruncated, "valueOmitted": visible.omitted,
                "valueType": visible.kind, "secure": secure, "childrenOmitted": secure, "enabled": enabled,
                "selectedTextRangeAvailable": selected != nil, "focusedAvailable": focused != nil, "selectionSettable": selectionSettable,
                "enabledAvailable": enabledValid && rawEnabled != nil && !identity.failed.contains(kAXEnabledAttribute),
                "frameAvailable": !rect.isNull, "windowFrameAvailable": !local.isEmpty,
                "actions": actions, "valueSettable": valueSettable, "readOnly": !canAct || actions.isEmpty && !valueSettable,
                "frame": rect.isNull ? [] : [rect.minX, rect.minY, rect.width, rect.height].map(Double.init), "windowFrame": local]
            if ancestorOnly { metadata["regionAncestorOnly"] = true }
            if menuAncestor { metadata["menuAncestor"] = true }
            if !visible.omitted { metadata["value"] = value.text }
            if let selected { metadata["selectedTextRange"] = selected }
            if let focused { metadata["focused"] = focused }
            nodes.append(WindowAXNode(ref: ref, element: element, parentRef: parentRef, role: role.text, identifier: identifier.text,
                title: title.text, value: value.text, frame: rect, enabled: enabled, actions: actions, valueSettable: valueSettable, metadata: metadata))
            if secure || !descend { return }
            let children = try children(element, nodeIndex: nodes.count - 1)
            if depth == maximumDepth {
                if !children.isEmpty { partial("depth_budget") }
                return
            }
            let childrenOfMenu = menuAncestor || rawRole.map(AXSnapshotReader.isMenuRole) == true
            for (childIndex, child) in children {
                guard nodes.count < WindowAXState.maximumNodes, remaining > 0, ProcessInfo.processInfo.systemUptime - started < 0.6 else {
                    partial(nodes.count == WindowAXState.maximumNodes ? "node_budget" : remaining == 0 ? "content_budget" : "time_budget"); break
                }
                try visit(child, parentRef: ref, index: childIndex, depth: depth + 1, registry: &registry, menuAncestor: childrenOfMenu)
            }
        }
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var assertions = 0
        func check(_ value: @autoclosure () -> Bool) throws {
            guard value() else { throw NativeFailure("window_ax_state_self_check_failed", details: ["assertion": assertions + 1]) }
            assertions += 1
        }
        for (text, cap, expected, truncated) in [("😀ab", 5, "😀a", true), ("😀", 3, "", true),
                                                  ("😀", 4, "😀", false), ("e\u{301}", 2, "e", true), ("", 0, "", false)] {
            var budget = cap
            let value = clip(text, maxBytes: cap, budget: &budget)
            try check(value.text == expected && value.truncated == truncated)
            try check(budget == cap - expected.utf8.count)
        }
        let grapheme = "a" + String(repeating: "\u{301}", count: 40_000)
        var budget = 64 * 1024
        let large = clip(grapheme, maxBytes: 16_384, budget: &budget)
        try check(large.truncated && large.text.utf8.count == 16_383 && budget == 49_153)
        var sum = large.text.utf8.count
        for _ in 0..<8 { sum += clip(grapheme, maxBytes: 16_384, budget: &budget).text.utf8.count }
        try check(sum <= 64 * 1024 && sum + budget == 64 * 1024 && budget >= 0)
        let tail = clip("more", maxBytes: 512, budget: &budget)
        try check(tail.truncated && tail.text.utf8.count <= 1)
        try check(optional(.noValue) && optional(.attributeUnsupported) && !optional(.cannotComplete) && !optional(.invalidUIElement))
        let invalid = validateStrings(Attributes(values: [kAXRoleAttribute: "AXTextField" as CFString,
            kAXTitleAttribute: NSNumber(value: 1), kAXIdentifierAttribute: NSNumber(value: 2), kAXSubroleAttribute: NSNumber(value: 3)]))
        try check(invalid.values[kAXRoleAttribute] as? String == "AXTextField")
        try check(invalid.failed == [kAXTitleAttribute, kAXIdentifierAttribute, kAXSubroleAttribute])
        try check(invalid.values[kAXTitleAttribute] == nil && invalid.values[kAXIdentifierAttribute] == nil)
        let nativeIdentifier = identifier(Attributes(values: [kAXIdentifierAttribute: "native" as CFString, domIdentifier: "dom" as CFString]))
        try check(nativeIdentifier.text == "native" && nativeIdentifier.source == kAXIdentifierAttribute && !nativeIdentifier.failed)
        let domFallback = identifier(Attributes(values: [kAXIdentifierAttribute: "" as CFString, domIdentifier: "dom" as CFString]))
        try check(domFallback.text == "dom" && domFallback.source == domIdentifier && !domFallback.failed)
        let failedNative = identifier(Attributes(values: [domIdentifier: "dom" as CFString], failed: [kAXIdentifierAttribute]))
        try check(failedNative.text == "dom" && !failedNative.failed)
        let failedDOM = identifier(Attributes(values: [kAXIdentifierAttribute: "native" as CFString], failed: [domIdentifier]))
        try check(failedDOM.source == kAXIdentifierAttribute && !failedDOM.failed)
        let bothFailed = identifier(Attributes(failed: [kAXIdentifierAttribute, domIdentifier]))
        try check(bothFailed.text.isEmpty && bothFailed.source == "missing" && bothFailed.failed)
        let absentIdentifiers = identifier(Attributes())
        try check(absentIdentifiers.source == "missing" && !absentIdentifiers.failed)
        let malformedDOM = validateStrings(Attributes(values: [domIdentifier: NSNumber(value: 1)]))
        try check(malformedDOM.failed.contains(domIdentifier) && identifier(malformedDOM).failed)
        try check(structural([kAXRoleAttribute]) && structural([kAXSubroleAttribute]))
        try check(!structural([kAXIdentifierAttribute, domIdentifier, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                               kAXPositionAttribute, kAXEnabledAttribute, kAXSelectedTextRangeAttribute, kAXFocusedAttribute]))
        let optionalFailure = Reader(bounds: CGRect(x: 0, y: 0, width: 100, height: 100), check: {})
        optionalFailure.attributeError("AXIdentifier_-25200")
        optionalFailure.attributeError("AXDescription_-25200")
        try check(optionalFailure.complete && (optionalFailure.diagnostics["incompleteReasons"] as? [String: Int])?.isEmpty == true)
        try check((optionalFailure.diagnostics["attributeErrors"] as? [String: Int])?["AXIdentifier_-25200"] == 1)
        let limited = optionalFailure.text(String(repeating: "x", count: 20_000), key: kAXValueAttribute, limit: 16_384)
        try check(limited.truncated && limited.text.utf8.count == 16_384 && optionalFailure.complete)
        optionalFailure.partial("children_read_failed")
        try check(!optionalFailure.complete)
        let contentLimited = Reader(bounds: CGRect(x: 0, y: 0, width: 100, height: 100), check: {})
        for _ in 0..<4 { _ = contentLimited.text(String(repeating: "x", count: 16_384), key: kAXValueAttribute, limit: 16_384) }
        try check(!contentLimited.complete && (contentLimited.diagnostics["incompleteReasons"] as? [String: Int])?["content_budget"] != nil)
        try check(selectionCandidate(secure: false, kind: "string", truncated: false, range: [0, 0]))
        try check(!selectionCandidate(secure: true, kind: "string", truncated: false, range: [0, 0]))
        try check(!selectionCandidate(secure: false, kind: "number", truncated: false, range: [0, 0]))
        try check(!selectionCandidate(secure: false, kind: "string", truncated: true, range: [0, 0]))
        try check(!selectionCandidate(secure: false, kind: "string", truncated: false, range: nil))
        try check(!protected(Attributes(values: [kAXRoleAttribute: "AXTextField" as CFString])))
        try check(protected(Attributes(values: [kAXRoleAttribute: "AXTextField" as CFString, kAXSubroleAttribute: "AXSecureTextField" as CFString])))
        try check(protected(Attributes(values: [kAXRoleAttribute: "AXTextField" as CFString], failed: [kAXSubroleAttribute])))
        try check(protected(Attributes()) && protected(Attributes(values: [kAXRoleAttribute: "" as CFString])))
        let absent = visibleValue(nil, secure: false)
        try check(absent.kind == "missing" && absent.omitted && absent.text.isEmpty)
        let empty = visibleValue("" as CFString, secure: false)
        try check(empty.kind == "string" && !empty.omitted && empty.text.isEmpty)
        let secret = visibleValue("must never appear" as CFString, secure: true)
        try check(secret.kind == "secure" && secret.omitted && secret.text.isEmpty)
        try check(visibleValue(NSNumber(value: 42), secure: false).text == "42")
        try check(visibleValue(kCFBooleanTrue, secure: false).kind == "boolean")
        let unsupported = visibleValue(["unexpected"] as CFArray, secure: false)
        try check(unsupported.kind == "unsupported" && unsupported.omitted && unsupported.text.isEmpty)
        for (location, length, expected) in [(0, 0, [0, 0]), (2, 4, [2, 4]), (10, 0, [10, 0])] {
            try check(selection(CFRange(location: location, length: length)) == expected)
        }
        for range in [CFRange(location: -1, length: 0), CFRange(location: 0, length: -1),
                      CFRange(location: kCFNotFound, length: 0), CFRange(location: NSNotFound, length: 0),
                      CFRange(location: 0, length: NSNotFound), CFRange(location: Int.max - 1, length: 2),
                      CFRange(location: 9_007_199_254_740_991, length: 1)] {
            try check(selection(range) == nil)
        }
        try check(selection(CFRange(location: 9_007_199_254_740_991, length: 0)) == [9_007_199_254_740_991, 0])
        try check(focused(kCFBooleanTrue) == true && focused(kCFBooleanFalse) == false)
        try check(focused(nil) == nil && focused("true" as CFString) == nil)
        try check(focused(NSNumber(value: 1)) == nil && focused(NSNumber(value: 0)) == nil)
        let locator: [String: Any] = ["ref": "a", "parentRef": NSNull(), "index": 3]
        try check(index(locator, ref: "a", parent: nil) == 3)
        try check(index(locator, ref: "b", parent: nil) == nil && index(locator, ref: "a", parent: "parent") == nil)
        try check(index(["ref": "a", "parentRef": NSNull(), "index": -1], ref: "a", parent: nil) == nil)
        try check(index(["ref": "a", "parentRef": "parent", "index": 0], ref: "a", parent: "parent") == 0)
        try check(index(["ref": "a", "parentRef": NSNumber(value: 1), "index": 0], ref: "a", parent: nil) == nil)
        var registry = Registry()
        let a = "first" as CFString, b = "second" as CFString
        let one = registry.reference(for: a, bucket: 0), two = registry.reference(for: b, bucket: 0)
        try check(one != two && registry.count == 2)
        try check(registry.reference(for: "first" as CFString, bucket: 0) == one)
        registry.retain([two])
        try check(registry.count == 1 && registry.reference(for: b, bucket: 0) == two)
        try check(registry.reference(for: a, bucket: 0) != one)
        let retainedReference = registry.reference(for: a, bucket: 0)
        try check(registry.retire(["second" as CFString]) == [two])
        try check(registry.reference(for: a, bucket: 0) == retainedReference)
        try check(registry.reference(for: b, bucket: 0) != two)
        try check(registry.retire(["absent" as CFString]).isEmpty)
        let state = WindowAXState()
        func record(_ id: String, _ value: String, parent: String? = nil, index: Int = 0) -> [String: Any] {
            ["ref": id, "value": value, "parentRef": parent as Any? ?? NSNull(), "index": index]
        }
        let first = try state.append([record("a", "1"), record("b", "2", parent: "a")], complete: true)
        try check(JSONSerialization.isValidJSONObject(first))
        try check(first["mode"] as? String == "full" && first["baseVersion"] is NSNull && first["version"] as? Int == 1)
        try check((first["added"] as? [[String: Any]])?.count == 2 && (first["removed"] as? [String]) == [])
        let unchanged = try state.append([record("a", "1"), record("b", "2", parent: "a")], complete: true)
        try check(unchanged["mode"] as? String == "delta" && unchanged["baseVersion"] as? Int == 1 && unchanged["version"] as? Int == 2)
        try check((unchanged["added"] as? [[String: Any]])?.isEmpty == true && (unchanged["changed"] as? [[String: Any]])?.isEmpty == true)
        let edit = try state.append([record("a", "new"), record("c", "3", parent: "a")], complete: true)
        try check(JSONSerialization.isValidJSONObject(edit))
        try check((edit["added"] as? [[String: Any]])?.first?["ref"] as? String == "c")
        try check((edit["changed"] as? [[String: Any]])?.first?["value"] as? String == "new")
        try check(edit["removed"] as? [String] == ["b"])
        let partial = try state.append([record("a", "new")], complete: false)
        try check(partial["mode"] as? String == "full" && partial["baseVersion"] is NSNull && partial["removed"] as? [String] == [])
        let afterPartial = try state.append([record("a", "new"), record("c", "3", parent: "a")], complete: true)
        try check(afterPartial["mode"] as? String == "full" && afterPartial["baseVersion"] is NSNull)
        let moved = try state.append([record("a", "new"), record("c", "3", parent: nil, index: 1)], complete: true)
        try check((moved["changed"] as? [[String: Any]])?.first?["parentRef"] is NSNull)
        let oldLineage = moved["lineageId"] as! String
        let oldReference = state.registry.reference(for: "retained element" as CFString)
        state.invalidate()
        try check(state.registry.count == 0 && state.node(ref: "a") == nil)
        try check(state.registry.reference(for: "retained element" as CFString) != oldReference)
        let reset = try state.append([record("a", "new")], complete: true)
        try check(reset["mode"] as? String == "full" && reset["lineageId"] as? String != oldLineage && reset["version"] as? Int == 7)
        let scoped = WindowAXState()
        let regionBounds = CGRect(x: 20, y: 10, width: 40, height: 30)
        let front = WindowAXRegion(bounds: regionBounds, pixels: regionBounds, fromEnd: false)
        let back = WindowAXRegion(bounds: regionBounds, pixels: regionBounds, fromEnd: true)
        try check(front.includes(.null))
        try check(front.includes(CGRect(x: 10, y: 0, width: 20, height: 20)))
        try check(!front.includes(CGRect(x: 62, y: 0, width: 10, height: 20)))
        let pid = getpid(), app = AXUIElementCreateApplication(pid)
        scoped.prepare(root: app, pid: pid, region: front)
        let firstScope = try scoped.append([record("a", "value")], complete: true)
        scoped.prepare(root: app, pid: pid, region: front)
        let sameScope = try scoped.append([record("a", "value")], complete: true)
        try check(sameScope["mode"] as? String == "delta" && sameScope["baseVersion"] as? Int == 1)
        scoped.prepare(root: app, pid: pid, region: back)
        let changedScope = try scoped.append([record("a", "value")], complete: true)
        try check(changedScope["mode"] as? String == "full" && changedScope["version"] as? Int == 3)
        try check(changedScope["lineageId"] as? String != firstScope["lineageId"] as? String)
        let shiftedPixels = WindowAXRegion(bounds: regionBounds, pixels: regionBounds.offsetBy(dx: 1, dy: 0), fromEnd: true)
        scoped.prepare(root: app, pid: pid, region: shiftedPixels)
        let shiftedScope = try scoped.append([record("a", "value")], complete: true)
        try check(shiftedScope["mode"] as? String == "full" && shiftedScope["lineageId"] as? String != changedScope["lineageId"] as? String)
        do {
            _ = try state.append([record("a", "one"), record("a", "two")], complete: true)
            throw NativeFailure("window_ax_state_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "window_ax_duplicate_reference") }
        try check(state.version == 7)
        let ordered = WindowAXState()
        _ = try ordered.append([record("a", "1"), record("b", "2", parent: "a"), record("c", "3", parent: "b")], complete: true)
        let removed = try ordered.append([], complete: true)
        try check(removed["removed"] as? [String] == ["c", "b", "a"])
        _ = try ordered.append([record("a", "1", index: 0)], complete: true)
        let reordered = try ordered.append([record("a", "1", index: 1)], complete: true)
        try check((reordered["changed"] as? [[String: Any]])?.count == 1)
        try check((reordered["changed"] as? [[String: Any]])?.first?["index"] as? Int == 1)
        let beforeVersion = ordered.version, beforeLineage = ordered.lineage, beforePrior = ordered.prior!.records
        let retained = ordered.registry.reference(for: "known" as CFString), beforeCount = ordered.registry.count
        let refreshed = ordered.usingRegistryCopy { registry -> [String: Any] in
            _ = registry.reference(for: "temporary" as CFString)
            return ["value": "fresh"]
        }
        try check(refreshed["value"] as? String == "fresh")
        try check(ordered.registry.count == beforeCount && ordered.registry.reference(for: "known" as CFString) == retained)
        try check(ordered.version == beforeVersion && ordered.lineage == beforeLineage)
        try check(NSArray(array: ordered.prior!.records).isEqual(to: beforePrior))
        do {
            try ordered.usingRegistryCopy { registry in
                _ = registry.reference(for: "failed temporary" as CFString)
                throw NativeFailure("cancelled")
            }
            throw NativeFailure("window_ax_state_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "cancelled") }
        try check(ordered.registry.count == beforeCount && ordered.version == beforeVersion && ordered.lineage == beforeLineage)
        let selectionState = WindowAXState()
        var selectionRecord = record("text", "abc")
        selectionRecord["selectedTextRange"] = [0, 1]; selectionRecord["focused"] = true
        _ = try selectionState.append([selectionRecord], complete: true)
        selectionRecord["selectedTextRange"] = [2, 0]; selectionRecord["focused"] = false
        let selectionChanged = try selectionState.append([selectionRecord], complete: true)
        let selectionChange = (selectionChanged["changed"] as! [[String: Any]]).first!
        try check(selectionChange["selectedTextRange"] as? [Int] == [2, 0] && selectionChange["focused"] as? Bool == false)
        let selectionUnavailable = try selectionState.append([record("text", "abc")], complete: true)
        let unavailable = (selectionUnavailable["changed"] as! [[String: Any]]).first!
        try check(unavailable["selectedTextRange"] == nil && unavailable["focused"] == nil)
        try check(JSONSerialization.isValidJSONObject(selectionChanged) && JSONSerialization.isValidJSONObject(selectionUnavailable))
        state.version = Int.max
        do {
            _ = try state.append([], complete: true)
            throw NativeFailure("window_ax_state_self_check_failed")
        } catch let error as NativeFailure { try check(error.code == "window_ax_version_exhausted") }
        try check(valid(CGRect(x: -100, y: -50, width: 500, height: 300)) && !valid(.null) && !valid(.zero))
        try check(!valid(CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1)))
        try check(!valid(CGRect(x: 0, y: 0, width: -1, height: 1)))
        try check(!valid(CGRect(x: CGFloat.greatestFiniteMagnitude, y: 0, width: CGFloat.greatestFiniteMagnitude, height: 1)))
        try check(relativeFrame(CGRect(x: -100, y: -50, width: 500, height: 300), bounds: CGRect(x: -200, y: -200, width: 800, height: 600)) == [100, 150, 500, 300])
        let extreme = CGFloat.greatestFiniteMagnitude
        try check(relativeFrame(CGRect(x: extreme, y: 0, width: 1, height: 1), bounds: CGRect(x: -extreme, y: 0, width: extreme, height: 1)).isEmpty)
        return assertions
    }
    #endif
}
