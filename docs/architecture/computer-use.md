# Computer use

Agent turns control an explicitly bound background window through Rome Desktop or an independent Rome Node host.
Core admits the turn, the host authenticates the caller, and the native helper checks the receiver before dispatch.

When Core runs in the macOS user's graphical session, it can pass the
approved local target directly to the shared host in its own process. The same
message grant and native receiver checks apply. Local discovery reads the
host's actual capability and permission report without a Gateway connection.

## Flow

```text
agent tools → Core admission → shared Node client → Gateway → selected host → signed native helper
```

Desktop embeds the same `@rome-os/node-core` host that the standalone Node command uses. Core binds the [turn and actor](../domains/agents.md#rome-tools) to references it issues. The host owns transport validation and durable action records. The native helper owns window identity, accessibility references, input serialization and operating-system permissions.

Remote Mac computer use follows the same permission model as ordinary Rome Node
actions. Web, Mac, and iPhone clients reach any paired Mac through the
authenticated instance, the Gateway, and the target host's **Computer use**
switch. The receiver can be an [independent Node](../rome-node.md#native-computer-use-on-macos)
or [signed-in Desktop](../rome-node.md#macos-app). In an eligible private
browser chat, the guardian authorizes a controller–target pair once and that
grant persists until revoked. Rome remembers each device separately and issues
short-lived authority for each dedicated turn using the selected device. Forks
receive no
part of that grant. When a granted turn finishes or fails, Core invalidates its
window references and requests cancellation of bindings that still lack stop
confirmation. Core cancels any binding that succeeds after its turn has ended
and discards its session reference. Check the device's stop receipt to confirm
that its input and capture stopped.

`computer_discover` reports the selected device's advertisements and the
`authorizedActions` for the current message. Core invokes only advertised
actions when the host reports a ready audit log. Window binding and replacement
require an advertised cancellation command. Ending, renewing and preempting also
require the helper's corresponding capability. Preemption needs its own message
grant. If the device's frame version is absent or unsupported, `binaryFrames` is
false and an advertised JSON observation is still available. Cancellation closes
local admission. A receipt without a verified stop leaves `stopConfirmed` false.

## Compatibility with an older instance

Run `rome-node connect` on the Mac (optionally with `--cloud <url>`, `--name <name>`, or
`--device-code`) to offer its background windows to paired instances in your account.
The CLI reuses its device sign-in. Each instance can discover the
advertised actions with `rome-node device describe` and call them with
`rome-node device run` on its existing connection. Web, Mac and iPhone
clients use the instance's ordinary Node action permissions.
[Node setup](../rome-node.md#native-computer-use-on-macos).

## Invariants

- Both hosts use one protocol and execution implementation. A Desktop-only input path cannot give an action different safety or result semantics.
- Core can run on another operating system. Native input occurs on the selected device, never on a substitute computer or a container desktop.
- The agent cannot select a helper executable, signing identity, process ID or private native operation through tool arguments.
- The helper is the permission owner. Its bundle identity, designated requirement and installation location stay stable across development rebuilds. Ad-hoc builds cannot request privacy permissions or execute computer input.
- Launching the helper preserves its independent application identity. Changing the shell, Node process or Electron build cannot silently make that process the permission owner.
- Ordinary status and discovery do not call permission-request APIs. Starting a helper with existing direct-capture authorization can still cause a macOS launch-disclosure prompt. Accessibility and screen capture remain separate permissions.
- A permission change first triggers a real capability check. If only a fresh process can use a grant, the helper restarts after input and capture stop. Desktop and Node remain running. Helper instance changes invalidate old sessions and observations without replaying input.
- A change of signing channel requires its own compatibility evidence. A development certificate does not establish that a distribution signature retains the same privacy access.
- The agent's declared capability controls tool visibility. The Core adapter checks live guardian identity and private audience on every invocation, including after an asynchronous reply. A catalog opened between turns grants no execution authority.
- Core-issued window and session references belong to one actor, agent session and device. Another turn cannot adopt an in-flight reply from a superseded turn. Forks cannot borrow their source's references.
- The host authenticates the Gateway caller and independently owns its sessions. The helper accepts only authenticated local connections from the same operating-system user through protected local state.
- Operating-system user isolation belongs outside this surface. A private socket does not sandbox other programs already running as its owner.
- Turning computer use off leaves no executor reachable through the limited host. Disconnecting, replacing or stopping a host closes its input admission before cleanup.
- Core close keeps its transport until accepted bindings settle and late sessions are cancelled. The host reclaims idle sessions at their binding deadline without deleting durable action records.
- Durable intent precedes dispatch. A lost acknowledgment, restart or new conversation cannot turn an accepted action identity into permission to replay it.
- A caller timeout does not release an occupied native input lane. Another action cannot pass through while that worker may still dispatch input.
- Native identity and receiver checks remain beside dispatch. A TypeScript observation cannot replace the native check immediately before an event or AX mutation.
- Cancellation bypasses the input lane. A local cancellation request is distinguished from a confirmed native stop. Cleanup and late evidence cannot replace the first accepted terminal cause.
- Dispatch and effect verification are different results. An AX success return or an emitted key event cannot establish completion. Unknown outcomes remain unknown even when later diagnostic evidence looks correct.
- A screenshot belongs to one observation and its window geometry. Binary transport keeps its bytes separate from metadata, and Core validates the bounded image before handing it to the model.
- Core checks that observations and receipts belong to the bound session. It checks the action ID on dispatch and verification receipts. If a dispatch receipt cannot be matched, Core closes input and reports the outcome as unknown.
- Window text, pixels and input contents can reach the admitted model, but remain absent from general activity records and default device audit content.
- Window input always targets the bound process and window. A background-only binding forbids automatic activation.

## Instance-local target

Set `ROME_COMPUTER_USE_LOCAL_DEVICE_ID` to a stable UUID for the device that
runs Core. Set `ROME_JWT_SECRET` to a strong instance-specific secret with at
least 32 characters (not the development default). Core validates the effective
signing secret at startup before enabling the local target.

A guardian in a private browser chat can authorize the local device or any
paired Mac once, and the grant persists until revoked. Computer-use target
discovery, approval changes, and per-turn grants require a signed guardian
session cookie (and a same-origin browser request for mutations). TCP loopback
trust alone does not grant computer-use access. The local and remote IDs must
differ. The agent checks each selected device's capabilities. Unsupported
platforms advertise system information without window actions. A supported Mac
reports its actual helper and permissions.

On Apple Silicon macOS, run Core in the graphical login session with the
signed native helper and its existing permission grants. Direct calls use
the same default helper state directory as Desktop and the standalone Node.
Core running inside Docker sees the container platform. To control a Mac
outside the container, select a separately approved Mac device.

## Window control

`computer_status` lists authorized devices and may include the device that asked.
The agent resolves an exact target, then calls `computer_discover` for that device.
Discovery reads `system.info` and, when advertised, `computer.status`. It reports
actions, configuration, permissions and helper capabilities from that device.
An absent advertisement stays unknown. Device and helper versions are metadata.
The binding and each element advertise the input that the agent can use.

`computer_bind` requires an explicit `windowRef` from window discovery.
Each discovery issues fresh references with their own 15-second lifetime.
Omitting it returns `window_selection_required` before capture or input APIs run.
The binding advertises `scope: "background"`, `realPointer: false` and `coordinateSpace: "window_image_pixels"`.
Opening a full-input binding requires the target application to own neither the system frontmost application nor the system key focus.
When the application owns both but another exact window is focused, binding selects the restricted `window_semantics` mode.
That binding uses AX only and never sends local focus notifications or pointer/keyboard events.
It advertises `click`, `press`, `setValue` and `selectText`, each requiring a fresh element ref and the element's advertised action.
`click` is a single left AX press on a supported button without coordinates. Text edits use an explicit complete `setValue` assignment.
`type`, raw keys, coordinates, dragging, scrolling and raw AX actions are unavailable in this mode.
The helper maps the application's focused AX window to its exact CG identity and checks it remains different from the target.
An unreadable focused window ends the session. Binding rejects the user's focused window.
The input mode stays fixed for the session. Unexpected acquisition of real focus stops a full-input session. A new binding can select the restricted mode.

When the window advertises `foregroundNavigationFallback`, Core requests it at bind time for ordinary tasks. For a task that must stay in the background, the agent sets `backgroundOnly: true` on every bind or preempt. The helper fixes this choice for the life of the binding. Older callers and restricted windows keep background-only behavior.

A caller can identify a single referenced click as repeatable navigation with `navigation: true`. Successful navigation must remove the source control. The macOS helper also recognizes the topic-detail breadcrumb in the qualified Feishu build. It sends the initial click to the window in the background. Two fresh reads must still find the same receiver and unchanged source. If the caller supplied a destination postcondition, a complete read must also find zero matching destinations. The helper can then activate the exact window and retry once under the original action ID. The agent issues one action and the user receives no separate prompt. The physical pointer stays independent. A subsequent user focus change stops the binding. The helper does not switch focus back.
After a foreground retry, the next observation returns a full tree. Its window and element action lists include only the pointer actions currently available, so callers replace cached references and their action lists together.

In full-input mode, a pointer click with an element reference requires the
fresh accessibility hit to resolve to that element or a descendant. A point
that resolves to a different control in the same window or intersects a
known unrelated pressable control is rejected before dispatch.
A coordinate-only click checks a fresh accessibility region at the requested pixel.
If the region is incomplete or contains pressable controls on separate branches,
the helper returns before sending input. The caller can inspect the toolbar and
use a fresh reference for its intended control.
For a referenced coordinate click based on a regional observation, the
point must be inside that region. A new observation can cover a wider area.
A receipt with `pointerTargetMatched` records the accessibility hit proof. Use
independent verification to confirm the effect.
This mode does not virtualize the application's keyboard responder chain or provide arbitrary simultaneous keyboard control.
User input can continue in a different window while these focus checks remain satisfied.
When only the frontmost application channel names the target application, active bindings block input while fresh samples converge.
Outside a negotiated activation, a full-input binding stops immediately if the application owns key focus.
An active semantic binding also waits for convergence when only the key focus channel names the target application and a different exact window owns that focus.
If the target application owns key focus, the helper must still resolve its exact focused window.
A mixed sample at least 350 ms after the first unresolved sample ends the session. A fresh allowed sample preserves the binding.
A pre-dispatch `focus_transitioning` error sends no input. Get a fresh observation before issuing another action.
If the same transient state appears after a successful AX call, the receipt still records dispatch. Effect verification can resume when focus settles.
Target takeover, expiry, console lock, capture termination, identity failure or cancellation stops control.
An occluded window can still qualify. Discovery can also find a window outside the current Space when its live AX window and WindowServer identity match and the application is visible and the window is unminimized.
Binding an off-screen window requires a usable window-only capture and selects `window_semantics` for the life of the binding.
These bindings render no cursor overlay. They still check real focus before dispatch.
If the previous window proof is lost or the user takes focus, rediscover the intended window on the same approved device once it is available in the background.
Bind it again and observe before choosing a new action. A failed window proof alone does not establish that the application closed.

`WindowControl.swift` binds the kernel process identity to the exact AX and WindowServer window relationship.
`WindowInput.swift` creates discrete PID- and window-directed events with a private event-source state.
Window routing uses public and private macOS APIs. A missing required API refuses the operation.
Local focus notifications go only to the target process. They do not authorize system activation or foreground restoration.
The helper has no global desktop dispatcher or input monitor.

Keyboard input keeps an application-local focus context across calls so asynchronous shortcut processing can finish.
One session owns that context per target process. A newer owner supersedes an older one, so cancelling the older session cannot deactivate the newer owner.
Cancellation latches immediately. Context cleanup takes the native lane after its input worker finishes and sends only process-local notifications.
If the user has taken real system focus in that application, cleanup skips those notifications.
Capture-stop confirmation and context release precede terminal-session reclamation.

A full-input binding advertises ten actions: `move`, `click`, `drag`, `scroll`, `key`, `type`, `press`, `setValue`, `selectText` and `performAction`.
Each element advertises its available semantic actions and raw AX actions.
The host checks both the binding capabilities and the current element reference.
`press`, `setValue`, `selectText` and `performAction` require a reference.
`click` and `scroll` accept a reference without coordinates. Supplied coordinates use the latest window image, not global screen points.
A floating pane can place a toolbar button over another button on the page. Locate the icon in the window image, identify its toolbar in a structured observation and use the button’s advertised `press` action. Widen the observation to include adjacent content when a layout ancestor falls outside the toolbar. A position shared by two controls does not identify which reference to press. Prefer a named link back to the list when the detail pane offers one.
If another control overlaps the default point for a single reference-only left click, the helper can choose an uncovered point within a complete observation. It checks that the new point still hits the same AX receiver before dispatch.
`performAction` accepts only an advertised AX action. `AXRaise` is forbidden.
Native menus, popup buttons and combo boxes do not advertise pointer, keyboard or raw AX actions.
Their tracking loops can acquire system key focus. Coordinate input also checks known menu bounds and a fresh application-restricted AX hit test before dispatch.
Unqualified menu control fails without input. This restriction cannot establish that every custom control is free of application-triggered focus changes.
The AX tree uses menu ancestry when advertising actions. Immediately before an AX press, the helper reads the live receiver's ancestry.

`setValue` assigns an AX value of at most 16,384 UTF-16 units.
`selectText` sets the AX selected range for one unambiguous text match, with optional prefix and suffix, or places a cursor before or after it.
It sends no keyboard or focus-preparation events.
`type` sends at most 4096 UTF-16 units without the clipboard. Unicode replacement uses the target's selected range.
`window_semantics` has no `type` action. A settable `AXSelectedText` attribute alone does not establish working insertion in an inactive browser window.
Preparing a keyboard receiver can move its local caret. The helper preserves a freshly checked selection around that preparation.
These operations do not provide IME composition or candidate-window support.
The eight-second dispatch budget also applies to long text. The parser limit does not promise completion within that budget.
Legacy bindings without the window capability marker retain the `setValue`-only, 180-unit contract.

Drag events follow the shared Bézier trajectory in window-local points.
An interrupted drag releases at the last dispatched window-local point after another kernel and window identity check.
Cleanup never reads, moves or restores the system pointer.
Cancellation prevents subsequent input but cannot retract an event or AX operation already sent.

`computer.end` shares the stop path and records `completed` when no earlier
terminal cause exists. The helper advertises `sessionEnd` in its background
capabilities. The stop receipt carries `stopConfirmed` independently of the
action receipt. The Host closes admission before waiting for the helper and
keeps an action's recorded evidence readable after normal end.

A helper that advertises `windowLease` accepts `lease: true` on bind. The
target's continuous clock controls expiry. The binding reports its idle timeout,
renewal interval and remaining milliseconds. `computer.renew` extends an open
lease up to its absolute deadline. A lease that expires keeps its terminal cause.
Signed remote bindings and replacements enable the lease automatically when the
target helper advertises support. Expiry is enforced on the target, including
when the caller loses the bind reply or its Gateway connection. A helper without
lease support can still bind with its ordinary session deadline. Explicit
`lease: true` requires native lease support.
At capacity, the host asks for native stop confirmation for leases past their
idle deadline. Confirmed sessions release host slots and retain durable action
receipts. An in-flight renewal can leave the session active, so its idle time
alone does not free a slot.
When a stale action or stopped-session error arrives after that deadline, the
host can ask a helper with session recovery for the same read-only stop receipt.
An exact match reports `stopConfirmed` in the error details. A stale action also
reports `effectStatus: not_dispatched`. The agent can then bind the same window
again, take a fresh observation and make a new decision. Earlier actions with
unknown outcomes still require recovery.

Window preemption requires the guardian to grant permission for that message
separately. When a bind reports that a window is busy, the helper may issue a
token for its current automation session. `computer.preempt` checks the token
against the exact window and session before it stops that session. It binds a new
session only after the previous input, capture and cleanup have stopped. A
`preemption_pending` response leaves the replacement unbound. On macOS, the
caller can check the same token again while its grant and reference are valid.
Once a newer session occupies the window, the earlier token cannot replace it.

`computer.recover` reads the caller's durable receipt for an action ID. A known
dispatch outcome, independent verification and confirmed session stop are separate
fields. A lost input reply stays unknown if the ledger has no outcome. When the
helper can still inspect an old session, a read-only status can confirm the stop.

The Host checks the native session and action IDs before it records dispatch or
verification. If verification reports a geometry change while the session is open,
the Host can read verification once more for the same action. A successful retry
still requires a matching receipt from the helper. A repeat failure leaves the
dispatch receipt available for recovery without verified effect.

Core scopes action IDs from granted turns to the Guardian, Agent session and
device. Another approved turn in that session can recover a receipt after a Core
restart. Core returns the action ID used by the agent. Treat earlier pilot
records that lack an Agent session as unknown in scoped recovery. Check the
window state before issuing a new action when the prior outcome is unknown.
Recovery gives the caller no new window or input references. The helper closes
old sessions and invalidates window references across sleep and wake.

A provider that advertises `durableWindowOccupancy` records its window claim
before starting work. The claim uses the kernel process identity and native
window ID. A stop confirmation in the same state directory survives provider
replacement. Process exit alone leaves the original worker's cleanup
unconfirmed, so the claim keeps that window occupied. Other window identities
can still bind. Callers sharing this arbitration use the same state directory.

## Observations and incremental state

`WindowAXState.swift` batches fresh AX attribute reads and caches the resulting baseline for comparison.
An observation has a 600 ms budget, at most 512 nodes, and a 64 KiB UTF-8 content budget.
Traversal depth is limited to 32 for whole-window observations and 48 for regional observations.
It reports incomplete traversal separately from unavailable optional attributes and truncated fields.
An unavailable optional attribute is unknown. It does not by itself establish that a node is missing.
Observations and their action authority expire after 15 seconds. The helper checks the age again immediately before input. If the observation expires during preparation, it returns `stale_observation` with `effectStatus: not_dispatched`. Get a new observation before choosing another action.

The wire response contains a `delta` with `mode`, `lineageId`, `baseVersion`, `version`, `complete`, `added`, `changed` and `removed`.
`stateVersion` equals `delta.version`. `elements` contains exactly the added and changed records.
A full response has `baseVersion: null`, all records in `added`, and no changed or removed references.
`computer.observe` accepts `full` and `baseVersion`. A missing or mismatched baseline produces a full reset.
An incomplete traversal also produces a full reset. Unvisited elements never become confirmed removals through a partial delta.

When a binding advertises `observationRegion`, `computer.observe` can accept a
`region` rectangle in window image pixels. The reply includes the region.
Traversal retains branches with unknown geometry. When the application reports
a hit at the region center, the helper can follow its ancestors back to the
bound window, even if a floating control extends outside a parent's frame.
An on-screen layout group can also extend past the region along one axis. The
helper checks its immediate children's frames and retains the group if a child
reaches into the region. This preserves a floating control when the center
hits the page behind it. Out-of-region ancestors carry no action authority. Set `region.fromEnd` to visit siblings in
reverse order while preserving their original indices. Changing either the
rectangle or the traversal direction starts a fresh lineage. Completeness
applies to the selected view. A requested screenshot still covers the bound
window.

The host keeps the full state cache separately from the observation's single-use action authority.
An action consumes that authority while leaving the baseline available for the next delta.
Termination or a helper instance change clears both.
Partial observations can authorize only their fresh references or valid window coordinates under an advertised `partialObservations` capability.
The shared SDK returns a materialized `observation`, the original wire `changes`, and optional image bytes.
Core only forwards a delta that matches the last complete baseline it delivered.
It drops observations superseded by a newer request and keeps lineage identifiers opaque to the agent.
The Agent receives the compact view by default. It folds unnamed
single-child AX groups that supply no distinct actions, hit area, or state.
Compact results can report repeated boolean flags and ordered action lists once in `elementDefaults`.
Merge these defaults into each element in that reply before applying the delta.
An explicit value on the element takes precedence, including an empty action list.
A field can have a default only when the device reported it for every element in the reply.
For a regional or incomplete observation, the source must report a total
child count of one for that group. Older peers can still fold qualifying
groups in complete whole-window trees.
Promoted children keep their original refs and take their outer group's
position under the nearest retained parent. Named groups, branching groups,
focus state, and actionable controls remain visible. Request `view: "detailed"`
to inspect the original grouping. Supply `subtreeRef` to show just that
element and its descendants. Keep the same region when expanding an element
from a regional observation. Core resolves the subtree from the fresh device
observation. Switching views or subtrees returns a full observation in the
selected view and subtree's lineage. A partial observation still gives no
evidence that an unvisited node is absent. The device wire format and action
reference validation retain the original tree.

A bound session keeps a ScreenCaptureKit stream restricted to its exact window for the native sharing indicator.
Binding requires an existing grant, confirmed stream start and a frame.
The stream runs at one frame per second without audio, the system cursor or recording files. Its frames are discarded.
Requested screenshots capture that window separately, with a 2048 by 1536 pixel limit and a 5 MiB PNG limit.
Stopping sharing terminates the session. macOS owns the indicator's appearance and placement.

## Effect verification

Dispatch returns `effectVerified: false`.
Generic input without a declared AX postcondition remains `unverifiable`.
An `expect` postcondition requires an independent fresh read and exactly one matching element in a complete tree.
Unknown or truncated comparison attributes cannot establish whole-tree uniqueness.
`setValue` and `selectText` also support independent value or selection-range readback.
Verification does not advance the public observation revision.

An internal virtual cursor position cannot verify a `move` effect.
A model can inspect another image to judge progress, but that judgment does not change the machine's receipt.
Readback proves the checked UI state. It does not prove every input's causal effect or the absence of all transient focus changes.

## Permissions and qualification

The local panel requests persistent Screen Recording and Accessibility access through explicit buttons.
Post-event access follows the Accessibility grant. Background control does not require Input Monitoring or a global event tap.
Opening the panel does not probe capture. **Check window access** tests capture against the helper's own permission panel.
Ordinary status and bind calls do not invoke permission-request APIs. The public panel offers no temporary sharing picker.

A real capability check follows a local grant.
If only a fresh process can use it, the panel first stops input and capture, then restarts only the helper once per authorization attempt.
Desktop and Node remain open. A capture failure with all required flags granted does not trigger an automatic restart.
Keep the signing identity, bundle identifier and installation path stable within a signing channel.
macOS revocation, upgrades and launch-disclosure rules can still require prompts. Rome cannot promise permanent prompt-free access.

The implementation has no TextEdit allowlist. Application compatibility remains a separate qualification question.
On the development Mac, complete AppKit, Electron-page and Chrome-page tasks cover text selection, Unicode replacement, shortcuts, semantic buttons and checkboxes, and scrolling. AppKit also covers a window-directed drag and release.
Real Core, caller daemon and loopback Gateway tasks run through Node and the actual Electron DeviceHost class with shared-helper identity checks. These checks exclude production Cloud enrollment and the outer Desktop account/settings flow.
Development rebuilds retain the installed grant on this Mac. Distribution permission continuity requires separate evidence.
Minimized windows, other Spaces, multiple displays, keyboard layouts and IME have no general qualification.
Unit checks and permission probes do not establish production Desktop, Cloud or remote Node task acceptance.

Qualify background interaction per application control. Read the resulting page or value after an action. Sample the foreground application, keyboard focus and physical pointer independently. If the page stays on the same step, record the control and the observed limit. A known control limitation can be documented for release while its internal cause remains open.

For a background-only task, report where progress stopped if the available background actions cannot complete it. For ordinary tasks, test automatic activation separately from strict background operation. Record window activation, verify the physical pointer and read back the task result. For a summary of five topics, check the summary against the body of each of the five topics.

## Virtual pointer

Each successful on-screen window binding starts its own virtual pointer in the exposed part of the target. The rounded gray arrow has a white rim and a Rome robot badge on its right. It starts dimmed and rocks gently while the agent reads or waits. Full occlusion suspends drawing until the target is exposed again. Window actions with a known position move the pointer to that position. The Electron and Node hosts use the same renderer. This virtual pointer does not move the system pointer.

The first available badge color is Rome's Coral Ember (`#d86f4c`). When it is occupied, the helper samples colors across the hue wheel and takes the candidate with the greatest minimum CIELAB distance to active badges. Each binding keeps its color until it ends. Verification changes the feedback ring independently.
The overlay stays at the normal window level, immediately above the bound target's window group. The renderer uses normal window bounds to find an exposed reading position. WindowServer composites elevated surfaces, including transparent screen-recording overlays, above the pointer.
The helper keeps a new overlay transparent until the WindowServer order confirms that relationship.
It never makes the overlay key, accepts a click, activates an application or changes the system pointer.

Pointer coordinates are local points measured from the target's top left. The renderer clips the arrow, trail, label and feedback to that window.
During changes to geometry, Space, display or window order, the helper suppresses drawing until it can verify the target and stacking again. Ending, cancelling or invalidating the binding removes its overlay.
WindowServer can keep target-owned title-bar surfaces between the overlay and target. The renderer subtracts their rectangles from its visible regions.
Overlapping rectangles stay excluded. An intervening window from another process invalidates the relative order.
The renderer uses Apple's [relative window ordering](https://developer.apple.com/documentation/appkit/nswindow/order(_:relativeto:)) and verifies the resulting normal-level window order.

Moves from rest can follow a broad arc or, over distances of at least 180 points, take two direct legs with a rounded turn.
The planner sometimes chooses the turn when the window has room. The pointer changes direction and slows through the corner in one continuous movement.
Sweeping paths use one or two cubic Bézier segments with free control handles for detours, reverse anticipation and overshoot. Held drag events use this family.
Adjacent segments match position, velocity and acceleration at each join. The time map eases the pointer into and out of motion.
Each move varies the handles, side and shoulder. Detours scale with the endpoint distance. The planner prefers available space near an edge and preserves feasible incoming velocity when retargeting.
Coordinate extrema bound the actual cubic path, allowing safe handles outside the target. Narrow targets reduce the detour before rendering.
This is a procedural motion model. It does not use recorded human trajectories or claim Codex's internal algorithm.
Distance sets its duration between 280 and 880 milliseconds. Short moves weaken detours and projection reversals.
Retargeting continues from the displayed position and feasible velocity, with a time map that starts at the inherited speed.
The system Reduce Motion setting removes movement and pulse animations.
Interaction feedback does not assert a click. Green feedback follows an independent successful AX readback.
After feedback, an active session keeps the pointer visible at 45% opacity and gently rocks the arrow around its fixed hotspot to indicate waiting for the next operation.
The arrow and its low-contrast robot badge rotate together around the hotspot. A short shadow separates the arrow from the page. Each positioned action moves from the previous hotspot. The next observation keeps that hotspot when it is exposed. If the hotspot is covered, the read indicator uses an exposed part of the same window. Reduce Motion keeps the dimmed pointer still.
Cancellation and invalid targets still hide the overlay.

The worker waits at most one second for visual movement before the final receiver proof starts.
The action rechecks observation expiry, focus and receiver identity after movement.
Cancellation interrupts that wait and hides the pointer. A rendering failure grants no input authority and does not replace dispatch or verification evidence.
Window-only observations exclude the separate overlay, so its pixels do not enter the agent's target screenshot.

Operational commands and host lifetime are in [Rome Node](../rome-node.md). Apple's [code identity rules](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html) explain why a stable designated requirement can recognize a changed executable as the same application.
