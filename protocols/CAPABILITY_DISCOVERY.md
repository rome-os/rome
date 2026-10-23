# Rome Capability Discovery Protocol

**Version:** 1.1
**Port:** 9368
**Transport:** HTTP/1.1 over Tailscale private network

## Overview

The Capability Discovery Protocol allows Rome instances on the same Tailscale network to advertise and discover each other's capabilities. Each instance runs an HTTP server on port **9368** that exposes what services it offers. Current capability types are:

- `agent`: a Rome daemon serving the dashboard and agent runtime
- `cdp_servers`: Chrome DevTools Protocol sessions exposed by Rome Desktop
- `mcp_servers`: MCP servers exposed by Rome Desktop

This enables the Rome backend and AI agents to discover available browser automation endpoints and tool servers across all machines belonging to the same user, without manual configuration.

## Network Model

```
┌─────────────────┐         Tailscale          ┌─────────────────┐
│  Rome Desktop A │◄──── private network ──────►│  Rome Desktop B │
│  100.64.x.x     │                             │  100.64.y.y     │
│  :9368           │                             │  :9368           │
└─────────────────┘                             └─────────────────┘
        ▲                                               ▲
        │           ┌─────────────────┐                 │
        └───────────│  Rome Backend   │─────────────────┘
                    │  (agent runner) │
                    └─────────────────┘
```

- Rome Desktop instances and Rome daemons listen on `0.0.0.0:9368`.
- Discovery relies on Tailscale: peers are enumerated via `tailscale status --json`, then each online peer is probed on port 9368.
- Traffic stays within the Tailscale network — not exposed to the public internet.

## Endpoints

### `GET /` — Capability Advertisement

Returns the full capability manifest for this instance.

**Request:**
```
GET / HTTP/1.1
Host: <tailscale-ip>:9368
```

**Response:** `200 OK`
```json
{
  "name": "rome-desktop",
  "version": "0.1.0",
  "hostname": "macbook-pro",
  "tailscale_ip": "100.64.1.42",
  "capabilities": {
    "agent": {
      "status": "running",
      "dashboard_url": "http://100.64.1.42",
      "dashboard_status_url": "http://100.64.1.42/api/health",
      "api_base_url": "http://100.64.1.42:4141",
      "last_health_check": "2026-03-10T10:00:00.000Z"
    },
    "cdp_servers": [
      {
        "name": "Personal Chrome",
        "port": 9222,
        "status": "running"
      },
      {
        "name": "Work Chrome",
        "port": 9223,
        "status": "running"
      }
    ],
    "mcp_servers": [
      {
        "name": "my-server",
        "host": "192.168.1.100",
        "port": 8080,
        "status": "healthy",
        "last_check": "2026-03-02T10:00:00.000Z"
      }
    ]
  },
  "uptime_seconds": 3600
}
```

**Response headers:**
```
Content-Type: application/json
```

The response carries no CORS header. Discovery runs server side, and a browser page must not read the manifest.

### `GET /health` — Health Check

Lightweight liveness probe.

**Request:**
```
GET /health HTTP/1.1
Host: <tailscale-ip>:9368
```

**Response:** `200 OK`
```json
{
  "status": "ok"
}
```

Implementations may return `503` with `{ "status": "degraded" }` when the capability server is up but the advertised service is unhealthy.

### Unrecognized Routes

**Response:** `404 Not Found`
```json
{
  "error": "not found"
}
```

## Schema Reference

### CapabilityInfo (root object)

| Field             | Type                | Required | Description                                       |
|-------------------|---------------------|----------|---------------------------------------------------|
| `name`            | string              | yes      | Application identifier (e.g. `"rome-desktop"`)    |
| `version`         | string              | yes      | Semantic version of the application               |
| `hostname`        | string              | yes      | OS hostname of this machine                       |
| `tailscale_ip`    | string \| null      | yes      | Tailscale IP, or `null` if not connected          |
| `capabilities`    | Capabilities        | yes      | Advertised capabilities                           |
| `uptime_seconds`  | number              | yes      | Seconds since the capability server started       |

### Capabilities

| Field             | Type                | Required | Description                                       |
|-------------------|---------------------|----------|---------------------------------------------------|
| `agent`           | AgentCapabilityInfo | no       | Rome agent/dashboard capability                   |
| `cdp_servers`     | CdpServerInfo[]     | yes      | Active Chrome DevTools Protocol sessions (may be empty if no browsers are running) |
| `mcp_servers`     | McpServerInfo[]     | yes      | Enabled MCP servers (may be empty)                |

New capability types may be added as additional keys in the future.

### AgentCapabilityInfo

| Field                 | Type           | Required | Description                                                  |
|-----------------------|----------------|----------|--------------------------------------------------------------|
| `status`              | string         | yes      | `"running"` or `"degraded"`                                  |
| `dashboard_url`       | string         | yes      | Base URL the desktop app should load for this agent          |
| `dashboard_status_url`| string         | yes      | Health endpoint for the advertised dashboard                 |
| `api_base_url`        | string         | yes      | Base URL for daemon-owned agent APIs on the same machine     |
| `last_health_check`   | string \| null | yes      | ISO 8601 timestamp of the daemon's last dashboard health check |

### CdpServerInfo

| Field    | Type   | Required | Description                                |
|----------|--------|----------|--------------------------------------------|
| `name`   | string | yes      | Human-readable name of the browser profile (e.g. "Personal Chrome") |
| `port`   | number | yes      | Local port where CDP WebSocket is listening (e.g. 9222) |
| `status` | string | yes      | `"running"` when present                   |

To connect from a remote peer: `ws://<tailscale_ip>:<port>`. The CDP port is on the same machine as the capability server. Multiple CDP servers may be running simultaneously (one per browser profile).

### McpServerInfo

| Field        | Type           | Required | Description                                    |
|--------------|----------------|----------|------------------------------------------------|
| `name`       | string         | yes      | Human-readable server name                     |
| `host`       | string         | yes      | IP or hostname where the MCP server runs       |
| `port`       | number         | yes      | Port of the MCP server                         |
| `status`     | string         | yes      | `"healthy"`, `"unhealthy"`, or `"unknown"`     |
| `last_check` | string \| null | yes      | ISO 8601 timestamp of last health check, or `null` if never checked |

## Peer Discovery

### Step 1: Enumerate Peers

Run `tailscale status --json`. Extract online peers from the `Peer` object. Each peer has a Tailscale IP in `TailscaleIPs[0]`.

### Step 2: Probe Port 9368

For each online peer, `GET http://<peer-ip>:9368/` with a **3-second timeout**.

| Outcome                     | Interpretation                          |
|-----------------------------|-----------------------------------------|
| 200 + valid JSON            | Peer is running Rome, parse as `CapabilityInfo` |
| Connection refused / timeout | Peer is not running Rome                |
| 200 + invalid JSON          | Something else on port 9368, ignore     |

### Step 3: Use Capabilities

From a successful response:
- **Agent**: If `capabilities.agent` is present, the desktop app should prefer `capabilities.agent.dashboard_url` over any localhost default. If no peer advertises `agent`, the desktop app should warn the user instead of silently assuming `localhost:3000`.
- **CDP**: Each entry in `capabilities.cdp_servers` is an independent browser. Connect via `ws://<tailscale_ip>:<cdp_server.port>` for browser automation. Use the `name` field to identify the right browser profile.
- **MCP servers**: Connect via `http://<host>:<port>` for tool access.

## Daemon Extensions

Rome daemons keep these additional HTTP routes on the same port:

- `GET /status` returns the full managed-service health snapshot.
- `POST /actions` accepts daemon control actions.

## Health Checking Contract

Any MCP server registered in this protocol is expected to implement:

```
GET /health HTTP/1.1
```

- **HTTP 200** = healthy (response body is not inspected)
- **Any other status / timeout / error** = unhealthy

Recommended health check interval: **60 seconds**.
Recommended timeout: **5 seconds**.

## Future Considerations

- **Protocol versioning**: Add `"protocol_version": 1` to the root response for forward compatibility.
- **Additional capabilities**: New capability types can be added as keys under `capabilities` without breaking existing consumers.
- **Authentication**: Currently relies on Tailscale network-level auth. If exposed beyond the tailnet, add token-based auth.
- **mDNS fallback**: For networks without Tailscale, mDNS/Bonjour could serve as an alternative discovery mechanism.
