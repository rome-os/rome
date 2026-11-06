# Sessions API scorecard

claude/project-thread-ddecb5 @ 58a687dd: 21/21 checks pass

| Check | Measured | Result |
|---|---|---|
| C1 The session imports no caller's module (Chats, connections, routines, chat settings, Concierge, the key parser) | 0 imports | pass |
| C2 The session's code names no platform or caller kind's product (webchat, telegram, Concierge, ...) | 0 mentions | pass |
| C3 The caller prepares the briefing and applies the connection's reset policy; the session does neither | 0 references | pass |
| C4 Callers find a session only through open(agent, caller) and session(id); acquire, acquireBySessionId and peek are gone | entry points: open, session; bypasses: none | pass |
| C5 The runners hand over a caller and read the turn; they do not re-derive the key or where the turn records | 0 re-derivations | pass |
| C6 A caller names a session by one id: no second id (rome session id, resume id, key string) in the open or turn options or the session's key | 0 second ids | pass |
| C7 open takes the caller as an opaque string its owning context mints | open's caller: CallerId; opaque: true | pass |
| C8 Only the caller codec spells or parses a session's stored key | 0 uses outside the codec | pass |
| C9 Open and turn options carry at most 6 fields each | SessionOpenOptions: 3, SendTurnOptions: 2 | pass |
| C11 Routes, Concierge, capabilities and other users of sessions read no session row and parse no caller; they mint it and ask the manager | 0 bypasses | pass |
| C12 Apps neither read nor build the stored caller string; they pass and read the typed caller | 0 uses | pass |
| C13 The SDK exports the typed caller and every turn, run, fork and action context it hands apps carries it | exports SessionCaller: true; missing on: none | pass |
| C14 The session reads no field of the caller and imports no caller codec | 0 reads | pass |
| C15 open options carry at most 3 fields (workingDir, model, effort) and turn options at most 2 (initiator, briefing) | SessionOpenOptions: 3, SendTurnOptions: 2 | pass |
| C16 The session records its own turns: no member says where a turn is recorded, and the runners record nothing | 0 leaks | pass |
| C17 Code outside Sessions imports only its public module (agent-sessions/index.ts), never a file inside | 0 imports of internals; the public module exports 41 names | pass |
| C18 No caller writes a session turn's trace: only the session's log does | 0 writers outside Sessions | pass |
| C19 Code outside Sessions names no turn table: it reads turns and traces through Sessions' public module | 0 reads outside Sessions | pass |
| C20 The session keeps the whole turn itself: prompt, answer and trace go to its own tables for every session, and no caller tells it what to skip | 0 places tell the session what to skip | pass |
| C21 A running turn keeps the reply address and shared context it captured; nothing falls back to the latest opener's surface or a queued turn's context | 0 fallbacks | pass |
| C22 The SDK's caller names identity only: no kind but a dashboard chat carries a chat id, and nothing folds a conversation into a caller | 0 places | pass |

## Quantities

- callerImports: 0
- platformNames: 0
- callerPolicies: 0
- rederivations: 0
- keyHelperUses: 0
- openOptionFields: 3
- turnOptionFields: 2
- deprecatedCallerReads: 7
- consumerBypasses: 0
- appStoredCaller: 0
- callerReads: 0
- internalImports: 0
- publicExports: 41
- callerTraceWriters: 0
- turnStoreLines: 218
- turnStoreReads: 14
- callerTraceReads: 0
- skipInstructions: 0
- turnFallbacks: 0
- conversationOnCaller: 0
- moduleLines: 5483
- appKeyParsing: 0

## Details

### C4

- AgentSessionManager.open
- AgentSessionManager.session
- AgentSessionManager.live
- AgentSessionManager.find
- AgentSessionManager.reset
- AgentSessionManager.findWorkingDirBySessionId
- AgentSessionManager.shutdown

### C9

- SessionOpenOptions: workingDir, model, effort
- SendTurnOptions: initiatedBy, briefing

