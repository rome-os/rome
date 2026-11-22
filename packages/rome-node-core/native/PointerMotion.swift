import Foundation
import CoreGraphics

struct PointerMotion {
    struct Sample {
        let position: CGPoint
        let velocity: CGVector
        let finished: Bool
    }

    enum Failure: Error {
        case invalidGeometry
        case invalidClock
        case invalidVelocity
        case selfCheckFailed(String)
    }

    private struct Curve {
        let lower: CGFloat
        let upper: CGFloat
        let controls: [CGPoint]
    }

    let startedAt: TimeInterval
    let duration: TimeInterval
    let bounds: CGRect
    let start: CGPoint
    let destination: CGPoint
    private let curves: [Curve]
    private let initialProgressSpeed: CGFloat
    private let allowsElbow: Bool

    init(start: CGPoint, destination: CGPoint, bounds: CGRect, startedAt: TimeInterval,
         initialVelocity: CGVector = .zero, reduceMotion: Bool = false, variation: UInt64 = 0,
         allowsElbow: Bool = true) throws {
        guard startedAt.isFinite else { throw Failure.invalidClock }
        guard initialVelocity.dx.isFinite, initialVelocity.dy.isFinite else { throw Failure.invalidVelocity }
        let span = hypot(bounds.width, bounds.height)
        guard bounds.origin.x.isFinite, bounds.origin.y.isFinite, bounds.size.width.isFinite, bounds.size.height.isFinite,
              bounds.size.width > 0, bounds.size.height > 0, bounds.maxX.isFinite, bounds.maxY.isFinite,
              span.isFinite, span < CGFloat.greatestFiniteMagnitude / 1000,
              Self.finite(start), Self.finite(destination) else { throw Failure.invalidGeometry }
        self.bounds = bounds
        self.allowsElbow = allowsElbow
        self.startedAt = startedAt
        self.start = Self.clamp(start, to: bounds)
        self.destination = Self.clamp(destination, to: bounds)
        let delta = CGPoint(x: self.destination.x - self.start.x, y: self.destination.y - self.start.y)
        let distance = hypot(delta.x, delta.y)
        duration = reduceMotion || distance == 0 ? 0 : min(0.88, max(0.28, 0.20 + sqrt(Double(distance)) * 0.024))
        let moving = initialVelocity.dx != 0 || initialVelocity.dy != 0
        initialProgressSpeed = moving ? 1 : 0
        guard duration > 0 else { curves = []; return }
        guard (startedAt + duration).isFinite, startedAt + duration > startedAt else { throw Failure.invalidClock }
        let localBounds = CGRect(x: bounds.minX - self.start.x, y: bounds.minY - self.start.y,
                                 width: bounds.width, height: bounds.height)
        let mixed = Self.mixed(variation)
        func unit(_ shift: Int) -> CGFloat { CGFloat((mixed >> shift) & 0xffff) / 65535 }
        if allowsElbow && !moving && distance >= 180 && (mixed >> 2) & 7 < 3 {
            let shortLeg = 0.18 + 0.14 * unit(16)
            let along = mixed & 2 == 0 ? shortLeg : 1 - shortLeg
            // A point on the circle with this chord as diameter gives a right angle at the elbow.
            let height = sqrt(along * (1 - along)) * (0.82 + 0.26 * unit(32))
            let side: CGFloat = mixed & 1 == 0 ? 1 : -1
            for offset in [side * height, -side * height] {
                let elbow = CGPoint(x: delta.x * along - delta.y * offset, y: delta.y * along + delta.x * offset)
                if localBounds.contains(elbow) {
                    curves = Self.roundedElbow(at: elbow, to: delta, halfWidth: 0.075 + 0.035 * unit(48))
                    return
                }
            }
        }
        let knot: CGFloat? = distance > 90 && mixed & 2 != 0 ? 0.55 + 0.15 * unit(32) : nil
        let firstSpan = knot ?? 1
        let baselineMiddle = Self.scale(delta, knot ?? 0.5)
        let baselineLast = Self.scale(delta, 1 - (1 - (knot ?? 0)) / 3)
        let baselineFirst = Self.scale(delta, firstSpan / 3)
        func build(_ first: CGPoint, _ middle: CGPoint, _ last: CGPoint) -> [Curve] {
            Self.build(destination: delta, first: first, middle: middle, last: last, knot: knot)
        }
        var inherited = CGPoint(x: initialVelocity.dx, y: initialVelocity.dy)
        let largest = max(abs(inherited.x), abs(inherited.y))
        let limit = span * 3 / duration
        if largest > limit { inherited = Self.scale(inherited, limit / largest) }
        let requestedFirst = Self.scale(inherited, CGFloat(duration) * firstSpan / 3)
        let safeFirst: CGPoint
        if moving {
            let zeroVelocityBase = build(.zero, baselineMiddle, baselineLast)
            let requestedBase = build(requestedFirst, baselineMiddle, baselineLast)
            let retained = Self.fittingScale(from: zeroVelocityBase, to: requestedBase, bounds: localBounds)
            safeFirst = Self.scale(requestedFirst, retained)
        } else { safeFirst = baselineFirst }
        let baseline = build(safeFirst, baselineMiddle, baselineLast)
        let direction = CGPoint(x: delta.x / distance, y: delta.y / distance)
        let normal = CGPoint(x: -direction.y, y: direction.x)
        let lateralVelocity = inherited.x * normal.x + inherited.y * normal.y
        let followVelocity = moving && abs(lateralVelocity) > max(1, hypot(inherited.x, inherited.y) * 0.08)
        let side: CGFloat = followVelocity ? (lateralVelocity > 0 ? 1 : -1) : (mixed & 1 == 0 ? 1 : -1)
        let shortScale = min(1, distance / 80)
        let height = (0.22 + 0.14 * unit(16)) * shortScale
        func point(_ along: CGFloat, _ lateral: CGFloat) -> CGPoint {
            CGPoint(x: delta.x * along + normal.x * distance * lateral,
                    y: delta.y * along + normal.y * distance * lateral)
        }
        func candidate(_ side: CGFloat, constrainTangents: Bool) -> [Curve] {
            let reversalScale = shortScale * (knot == nil ? 1 : 0.6)
            var first = moving ? safeFirst : point(-(0.12 + 0.23 * unit(0)) * reversalScale,
                                                   side * height * (1.1 + 0.6 * unit(48)))
            let middle = point((knot ?? 0.6) + 0.03 + 0.06 * unit(0), side * height)
            let exitHeight = knot == nil ? 1.1 + 0.6 * unit(32) : 0.8 - 1.2 * unit(48)
            var last = point(1 + (0.12 + 0.23 * unit(32)) * reversalScale, side * height * exitHeight)
            if constrainTangents {
                if !moving { first = Self.clamp(first, to: localBounds) }
                last = Self.clamp(last, to: localBounds)
            }
            let result = build(first, middle, last)
            guard !moving else { return result }
            let projected = result.map { curve in
                Curve(lower: curve.lower, upper: curve.upper, controls: curve.controls.map { p in
                    CGPoint(x: p.x * direction.x + p.y * direction.y, y: p.x * normal.x + p.y * normal.y)
                })
            }
            let peak = projected.flatMap { Self.extrema($0.controls) }.map { abs($0.y) }.max() ?? 0
            let targetHeight = distance * height
            guard peak > 0, targetHeight > 0 else { return result }
            // Normalize visible excursion, since handle offsets are not the cubic's actual peak.
            let lateral = projected.map { curve in
                Curve(lower: curve.lower, upper: curve.upper, controls: curve.controls.map { CGPoint(x: $0.x, y: $0.y * targetHeight / peak) })
            }
            return lateral.map { curve in
                Curve(lower: curve.lower, upper: curve.upper, controls: curve.controls.map { p in
                    CGPoint(x: p.x * direction.x + p.y * normal.x, y: p.x * direction.y + p.y * normal.y)
                })
            }
        }
        var desired = candidate(side, constrainTangents: false)
        var fitted = Self.fittingScale(from: baseline, to: desired, bounds: localBounds)
        let opposite = candidate(-side, constrainTangents: false)
        let oppositeFit = Self.fittingScale(from: baseline, to: opposite, bounds: localBounds)
        if (!followVelocity && fitted < 0.8 || fitted < 0.25) && oppositeFit > fitted + 0.15 {
            desired = opposite
            fitted = oppositeFit
        }
        // Adjust unavailable endpoint tangents before flattening the entire detour against an edge.
        if fitted < 0.5 {
            for direction in [side, -side] {
                let constrained = candidate(direction, constrainTangents: true)
                let scale = Self.fittingScale(from: baseline, to: constrained, bounds: localBounds)
                if scale > fitted + 0.05 { desired = constrained; fitted = scale }
            }
        }
        curves = Self.blend(baseline, desired, fitted)
    }

    func sample(at time: TimeInterval) -> Sample {
        guard time.isFinite, duration > 0, time < startedAt + duration else {
            return Sample(position: destination, velocity: .zero, finished: true)
        }
        let t = CGFloat(min(1, max(0, (time - startedAt) / duration)))
        let progress = Self.progress(t, initialSpeed: initialProgressSpeed)
        let curve = curves.first { progress.position < $0.upper } ?? curves[curves.count - 1]
        let range = curve.upper - curve.lower
        let u = min(1, max(0, (progress.position - curve.lower) / range))
        let local = Self.evaluate(curve.controls, at: u)
        let derivative = Self.evaluate(Self.derivative(curve.controls), at: u)
        // The extrema check bounds the path; clamp only floating-point residue from evaluation.
        let position = Self.clamp(CGPoint(x: start.x + local.x, y: start.y + local.y), to: bounds)
        let speed = progress.velocity / (range * CGFloat(duration))
        return Sample(position: position, velocity: CGVector(dx: derivative.x * speed, dy: derivative.y * speed), finished: false)
    }

    func retarget(to point: CGPoint, at time: TimeInterval, reduceMotion: Bool = false,
                  variation: UInt64 = 0) throws -> PointerMotion {
        guard time.isFinite else { throw Failure.invalidClock }
        let current = sample(at: time)
        return try PointerMotion(start: current.position, destination: point, bounds: bounds, startedAt: time,
                                 initialVelocity: current.velocity, reduceMotion: reduceMotion, variation: variation,
                                 allowsElbow: allowsElbow)
    }

    private static func roundedElbow(at elbow: CGPoint, to end: CGPoint, halfWidth: CGFloat) -> [Curve] {
        func lerp(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
            CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        }
        // Inset the tangent guides along the chord so the long legs ease into alignment with the turn.
        let lead = scale(end, 0.04), settle = scale(end, 0.98)
        let approach = hypot(elbow.x, elbow.y)
        let turn = approach / (approach + hypot(end.x - elbow.x, end.y - elbow.y))
        let entry = lerp(elbow, lead, halfWidth / turn)
        let exit = lerp(elbow, settle, halfWidth / (1 - turn))
        let incoming = lerp(elbow, entry, 1.0 / 3)
        let outgoing = lerp(elbow, exit, 1.0 / 3)
        // The midpoint bisects the two tangents. Thirds on each leg match acceleration at all three joins.
        let middle = lerp(incoming, outgoing, 0.5)
        return [Curve(lower: 0, upper: turn - halfWidth, controls: [.zero, lerp(lead, entry, 1.0 / 3), lerp(lead, entry, 2.0 / 3), entry]),
                Curve(lower: turn - halfWidth, upper: turn, controls: [entry, lerp(entry, incoming, 0.5), incoming, middle]),
                Curve(lower: turn, upper: turn + halfWidth, controls: [middle, outgoing, lerp(outgoing, exit, 0.5), exit]),
                Curve(lower: turn + halfWidth, upper: 1, controls: [exit, lerp(exit, settle, 1.0 / 3), lerp(exit, settle, 2.0 / 3), end])]
    }

    private static func build(destination: CGPoint, first: CGPoint, middle: CGPoint, last: CGPoint, knot: CGFloat?) -> [Curve] {
        guard let s = knot else { return [Curve(lower: 0, upper: 1, controls: [.zero, first, last, destination])] }
        let r = 1 - s
        // Shared derivative g solves C2 after dividing each cubic's derivatives by its parameter span.
        let g = CGPoint(x: (s * s * (last.x - middle.x) - r * r * (first.x - middle.x)) / (2 * s * r),
                        y: (s * s * (last.y - middle.y) - r * r * (first.y - middle.y)) / (2 * s * r))
        let before = CGPoint(x: middle.x - s * g.x, y: middle.y - s * g.y)
        let after = CGPoint(x: middle.x + r * g.x, y: middle.y + r * g.y)
        return [Curve(lower: 0, upper: s, controls: [.zero, first, before, middle]),
                Curve(lower: s, upper: 1, controls: [middle, after, last, destination])]
    }

    private static func progress(_ t: CGFloat, initialSpeed a: CGFloat) -> (position: CGFloat, velocity: CGFloat, acceleration: CGFloat) {
        let position = a * t + (10 - 6 * a) * t * t * t + (8 * a - 15) * pow(t, 4) + (6 - 3 * a) * pow(t, 5)
        let h = a + 2 * a * t + (30 - 15 * a) * t * t
        // For a in {0,1}, h is nonnegative and q' and q'' vanish at the resting end.
        let velocity = (1 - t) * (1 - t) * h
        let acceleration = -2 * (1 - t) * h + (1 - t) * (1 - t) * (2 * a + 2 * (30 - 15 * a) * t)
        return (min(1, max(0, position)), velocity, acceleration)
    }

    private static func blend(_ first: [Curve], _ second: [Curve], _ amount: CGFloat) -> [Curve] {
        zip(first, second).map { a, b in
            Curve(lower: a.lower, upper: a.upper, controls: zip(a.controls, b.controls).map { p, q in
                CGPoint(x: p.x * (1 - amount) + q.x * amount, y: p.y * (1 - amount) + q.y * amount)
            })
        }
    }

    private static func fittingScale(from baseline: [Curve], to desired: [Curve], bounds: CGRect) -> CGFloat {
        if fits(desired, bounds: bounds) { return 1 }
        var lower: CGFloat = 0, upper: CGFloat = 1
        // A rectangle is convex, so feasibility stays monotone when blending from a bounded baseline.
        for _ in 0..<24 {
            let middle = (lower + upper) / 2
            if fits(blend(baseline, desired, middle), bounds: bounds) { lower = middle } else { upper = middle }
        }
        return lower
    }

    private static func fits(_ curves: [Curve], bounds: CGRect) -> Bool {
        let tolerance = hypot(bounds.width, bounds.height) * 1e-11
        for curve in curves {
            guard curve.controls.allSatisfy(finite) else { return false }
            for point in extrema(curve.controls) {
                if !finite(point) || point.x < bounds.minX - tolerance || point.x > bounds.maxX + tolerance ||
                    point.y < bounds.minY - tolerance || point.y > bounds.maxY + tolerance { return false }
            }
        }
        return true
    }

    private static func extrema(_ controls: [CGPoint]) -> [CGPoint] {
        var parameters: [CGFloat] = [0, 1]
        for axis in 0...1 {
            let p = controls.map { axis == 0 ? $0.x : $0.y }
            let d = zip(p, p.dropFirst()).map { $1 - $0 }
            let scale = d.map { abs($0) }.max() ?? 0
            if scale == 0 { continue }
            let x = d[0] / scale, y = d[1] / scale, z = d[2] / scale
            let a = x - 2 * y + z, b = 2 * (y - x), c = x
            if abs(a) < 1e-14 {
                if abs(b) > 1e-14 { parameters.append(-c / b) }
            } else {
                let discriminant = b * b - 4 * a * c
                if discriminant >= 0 {
                    let q = -0.5 * (b + (b >= 0 ? 1 : -1) * sqrt(discriminant))
                    parameters.append(q / a)
                    if q != 0 { parameters.append(c / q) }
                }
            }
        }
        return parameters.filter { $0 >= 0 && $0 <= 1 }.map { evaluate(controls, at: $0) }
    }

    private static func finite(_ point: CGPoint) -> Bool { point.x.isFinite && point.y.isFinite }
    private static func scale(_ point: CGPoint, _ scale: CGFloat) -> CGPoint { CGPoint(x: point.x * scale, y: point.y * scale) }
    private static func clamp(_ point: CGPoint, to bounds: CGRect) -> CGPoint {
        CGPoint(x: min(bounds.maxX, max(bounds.minX, point.x)), y: min(bounds.maxY, max(bounds.minY, point.y)))
    }
    private static func mixed(_ seed: UInt64) -> UInt64 {
        var value = seed &+ 0x9e3779b97f4a7c15
        value = (value ^ (value >> 30)) &* 0xbf58476d1ce4e5b9
        value = (value ^ (value >> 27)) &* 0x94d049bb133111eb
        return value ^ (value >> 31)
    }
    private static func derivative(_ points: [CGPoint]) -> [CGPoint] {
        let degree = CGFloat(points.count - 1)
        return zip(points, points.dropFirst()).map { first, second in
            CGPoint(x: (second.x - first.x) * degree, y: (second.y - first.y) * degree)
        }
    }
    private static func evaluate(_ controls: [CGPoint], at t: CGFloat) -> CGPoint {
        var points = controls
        for count in stride(from: points.count - 1, through: 1, by: -1) {
            for index in 0..<count {
                points[index] = CGPoint(x: points[index].x * (1 - t) + points[index + 1].x * t,
                                        y: points[index].y * (1 - t) + points[index + 1].y * t)
            }
        }
        return points[0]
    }

    #if ROME_COMPUTER_USE_SELF_TEST
    static func selfCheck() throws -> Int {
        var assertions = 0
        func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
            guard value() else { throw Failure.selfCheckFailed(message) }
            assertions += 1
        }
        func close(_ a: CGFloat, _ b: CGFloat, _ tolerance: CGFloat = 1e-6) -> Bool { abs(a - b) <= tolerance }
        func inside(_ p: CGPoint, _ rect: CGRect) -> Bool {
            p.x >= rect.minX - 1e-7 && p.x <= rect.maxX + 1e-7 && p.y >= rect.minY - 1e-7 && p.y <= rect.maxY + 1e-7
        }
        let rect = CGRect(x: 0, y: 0, width: 1800, height: 1400)
        let family = try (0..<32).map { seed in
            try PointerMotion(start: CGPoint(x: 450, y: 700), destination: CGPoint(x: 1100, y: 700),
                              bounds: rect, startedAt: 10, variation: UInt64(seed))
        }
        let path = family[0]
        try check(path.sample(at: 9).position == path.start && path.sample(at: 10).velocity == .zero,
                  "A resting move must start at its presentation point without extrapolation.")
        try check(path.sample(at: 10 + path.duration).position == path.destination && path.sample(at: 12).finished,
                  "Every movement must finish exactly at its destination.")
        try check(Set(family.map { $0.curves.count }) == [1, 2, 4] && family.allSatisfy { $0.curves.allSatisfy { $0.controls.count == 4 } },
                  "Long moves must include both sweeping paths and rounded elbows.")
        var peaks: [CGFloat] = [], backward: [CGFloat] = [], overshoot: [CGFloat] = []
        for motion in family {
            let frames = (0...600).map { motion.sample(at: 10 + motion.duration * Double($0) / 600) }
            try check(frames.allSatisfy { inside($0.position, rect) && finite($0.position) && $0.velocity.dx.isFinite && $0.velocity.dy.isFinite },
                      "Every varied path and its velocity must remain finite and bounded.")
            if motion.curves.count == 4 {
                let entry = motion.curves[0].controls.last!
                let exit = motion.curves[3].controls.first!
                let dx = motion.destination.x - motion.start.x - exit.x
                let dy = motion.destination.y - motion.start.y - exit.y
                let angle = abs(atan2(entry.x * dy - entry.y * dx, entry.x * dx + entry.y * dy))
                try check(angle > 75 * .pi / 180 && angle < 100 * .pi / 180 &&
                          motion.curves[2].upper - motion.curves[1].lower <= 0.221,
                          "An elbow must concentrate a near-right-angle turn between two distinct legs.")
                try check(zip(frames, frames.dropFirst()).allSatisfy { $0.position.x <= $1.position.x + 1e-8 },
                          "The elbow must approach and settle without overshooting or backing up.")
            } else {
                peaks.append(frames.map { abs($0.position.y - 700) }.max()!)
                backward.append(450 - frames.map { $0.position.x }.min()!)
                overshoot.append(frames.map { $0.position.x }.max()! - 1100)
            }
            for endpoint: CGFloat in [0, 1] {
                let clock = progress(endpoint, initialSpeed: 0)
                try check(clock.velocity == 0 && clock.acceleration == 0,
                          "The time map must give exact zero endpoint velocity and acceleration without collapsed handles.")
            }
            for (left, right) in zip(motion.curves, motion.curves.dropFirst()) {
                let first = evaluate(derivative(left.controls), at: 1), second = evaluate(derivative(right.controls), at: 0)
                let leftSpan = left.upper - left.lower, rightSpan = right.upper - right.lower
                let a = evaluate(derivative(derivative(left.controls)), at: 1), b = evaluate(derivative(derivative(right.controls)), at: 0)
                try check(close(first.x / leftSpan, second.x / rightSpan) && close(first.y / leftSpan, second.y / rightSpan) &&
                          close(a.x / (leftSpan * leftSpan), b.x / (rightSpan * rightSpan)) &&
                          close(a.y / (leftSpan * leftSpan), b.y / (rightSpan * rightSpan)),
                          "Two cubic pieces must match velocity and acceleration in the global spatial parameter.")
                try check(hypot(first.x, first.y) > 1,
                          "A smooth internal join must not introduce an artificial stop.")
            }
        }
        try check(peaks.min()! > 142.99 && peaks.max()! > 200 && peaks.max()! <= 234.001,
                  "Unobstructed long paths must normalize their visible detour to 22 to 36 percent of the chord.")
        try check(backward.min()! > 1 && overshoot.min()! > 1,
                  "Spatial handles must express reverse anticipation and overshoot in the same path.")
        try check(Set(peaks.map { Int($0.rounded()) }).count > peaks.count / 2,
                  "Stable seeds must vary the large detour rather than replaying one fixed template.")
        for seed in 0..<32 {
            let short = try PointerMotion(start: path.start, destination: CGPoint(x: path.start.x + 179, y: path.start.y),
                                          bounds: rect, startedAt: 0, variation: UInt64(seed))
            let drag = try PointerMotion(start: path.start, destination: path.destination, bounds: rect,
                                         startedAt: 0, variation: UInt64(seed), allowsElbow: false)
            try check(short.curves.count <= 2 && drag.curves.count <= 2,
                      "Short moves and held drag events must keep their original path family.")
        }
        let repeated = try PointerMotion(start: path.start, destination: path.destination, bounds: rect, startedAt: 10)
        try check((0...100).allSatisfy { path.sample(at: 10 + path.duration * Double($0) / 100).position ==
                  repeated.sample(at: 10 + repeated.duration * Double($0) / 100).position }, "Variation must be deterministic.")
        let points = [CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 1), CGPoint(x: 1, y: 1), CGPoint(x: 1, y: 0)]
        let synthetic = [Curve(lower: 0, upper: 1, controls: points)]
        try check(fits(synthetic, bounds: CGRect(x: 0, y: 0, width: 1, height: 0.75)) &&
                  !fits(synthetic, bounds: CGRect(x: 0, y: 0, width: 1, height: 0.749)),
                  "Analytic coordinate extrema must detect the cubic peak even when controls lie outside.")
        let example = [Curve(lower: 0, upper: 1, controls: [.zero, CGPoint(x: -0.35, y: -0.52), CGPoint(x: 1.35, y: -0.46), CGPoint(x: 1, y: 0)])]
        try check(fits(example, bounds: CGRect(x: -0.05, y: -0.37, width: 1.1, height: 0.38)),
                  "Safe free handles outside a rectangle must not force the actual curve to flatten.")
        for nearX: CGFloat in [10, 990] {
            let edgeBounds = CGRect(x: 0, y: 0, width: 1000, height: 800)
            for seed in 0..<16 {
                let edge = try PointerMotion(start: CGPoint(x: nearX, y: 700), destination: CGPoint(x: nearX, y: 200),
                                             bounds: edgeBounds, startedAt: 0, variation: UInt64(seed))
                let frames = (0...300).map { edge.sample(at: edge.duration * Double($0) / 300).position }
                try check(frames.allSatisfy { inside($0, edgeBounds) } && frames.map { abs($0.x - nearX) }.max()! > 35,
                          "An edge must favor an available detour instead of forcing every variation flat.")
            }
        }
        let clock = 10 + path.duration * 0.35, before = path.sample(at: clock)
        let changed = try path.retarget(to: CGPoint(x: 1450, y: 900), at: clock, variation: 9)
        let after = changed.sample(at: clock)
        try check(before.position == after.position && close(before.velocity.dx, after.velocity.dx) && close(before.velocity.dy, after.velocity.dy),
                  "A feasible retarget must inherit presentation position and velocity without restarting at rest.")
        let epsilon = 1e-6
        let left = changed.sample(at: clock + epsilon), right = changed.sample(at: clock + 3 * epsilon)
        let center = changed.sample(at: clock + 2 * epsilon)
        try check(close((right.position.x - left.position.x) / (2 * epsilon), center.velocity.dx, 0.002) &&
                  close((right.position.y - left.position.y) / (2 * epsilon), center.velocity.dy, 0.002),
                  "Reported velocity must match the independently sampled path after retargeting.")
        let small = try PointerMotion(start: CGPoint(x: 100, y: 100), destination: CGPoint(x: 101, y: 100), bounds: rect, startedAt: 0)
        try check((0...200).allSatisfy { let p = small.sample(at: small.duration * Double($0) / 200).position; return p.x > 99.9 && p.x < 101.1 && abs(p.y - 100) < 0.1 },
                  "Very short moves must weaken detour and projection reversals.")
        let narrow = try PointerMotion(start: CGPoint(x: 200, y: 700), destination: CGPoint(x: 700, y: 700),
                                      bounds: CGRect(x: 0, y: 699, width: 1000, height: 2), startedAt: 0)
        try check((0...500).allSatisfy { inside(narrow.sample(at: narrow.duration * Double($0) / 500).position, narrow.bounds) },
                  "A narrow target must constrain the actual cubic path.")
        let edge = try PointerMotion(start: CGPoint(x: 999, y: 799), destination: .zero,
                                     bounds: CGRect(x: 0, y: 0, width: 1000, height: 800), startedAt: 0,
                                     initialVelocity: CGVector(dx: 10000, dy: 10000))
        try check((0...400).allSatisfy { inside(edge.sample(at: edge.duration * Double($0) / 400).position, edge.bounds) },
                  "Infeasible outgoing momentum must be reduced at the boundary.")
        let reduced = try PointerMotion(start: .zero, destination: CGPoint(x: 10, y: 10), bounds: rect, startedAt: 42, reduceMotion: true)
        let still = try PointerMotion(start: .zero, destination: .zero, bounds: rect, startedAt: 42)
        try check(reduced.duration == 0 && reduced.sample(at: 42).finished && reduced.sample(at: 42).position == reduced.destination && still.duration == 0,
                  "Reduced motion and zero-distance actions must complete immediately.")
        try check(path.sample(at: .nan).finished && path.sample(at: .infinity).position == path.destination,
                  "Invalid sample clocks must stop without non-finite geometry.")
        for invalid in [CGRect.zero, CGRect(x: 0, y: 0, width: -1, height: 1), CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 1),
                        CGRect(x: CGFloat.nan, y: 0, width: 1, height: 1)] {
            do { _ = try PointerMotion(start: .zero, destination: .zero, bounds: invalid, startedAt: 0)
                throw Failure.selfCheckFailed("Invalid geometry was accepted.")
            } catch Failure.invalidGeometry { assertions += 1 }
        }
        do { _ = try PointerMotion(start: .zero, destination: .zero, bounds: rect, startedAt: .nan)
            throw Failure.selfCheckFailed("Invalid clock was accepted.")
        } catch Failure.invalidClock { assertions += 1 }
        do { _ = try PointerMotion(start: .zero, destination: CGPoint(x: 1, y: 1), bounds: rect, startedAt: Double.greatestFiniteMagnitude)
            throw Failure.selfCheckFailed("An unrepresentable clock was accepted.")
        } catch Failure.invalidClock { assertions += 1 }
        do { _ = try PointerMotion(start: CGPoint(x: CGFloat.nan, y: 0), destination: .zero, bounds: rect, startedAt: 0)
            throw Failure.selfCheckFailed("Invalid endpoint was accepted.")
        } catch Failure.invalidGeometry { assertions += 1 }
        do { _ = try PointerMotion(start: .zero, destination: .zero, bounds: rect, startedAt: 0, initialVelocity: CGVector(dx: CGFloat.infinity, dy: 0))
            throw Failure.selfCheckFailed("Invalid velocity was accepted.")
        } catch Failure.invalidVelocity { assertions += 1 }
        do { _ = try path.retarget(to: .zero, at: .nan)
            throw Failure.selfCheckFailed("Invalid retarget clock was accepted.")
        } catch Failure.invalidClock { assertions += 1 }
        return assertions
    }
    #endif
}
