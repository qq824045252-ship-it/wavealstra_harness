# MyBuddy Android / Mobile Remote

Remote Access keeps the Agent runtime, task database, memory, workspaces, projects, skills, MCP tools, and file authority on the Windows host. The mobile client only consumes the narrow `/v1` API (Bearer-token authenticated, zod-strict payloads) plus the bundled SPA.

The server supports **three network channels**. Pick one per device; all channels share the same pairing and device-token model, and one phone can move between them without re-pairing (token and baseUrl are decoupled).

| | Tailscale HTTPS | LAN HTTP | USB direct |
|---|---|---|---|
| Server bind | `127.0.0.1` | `0.0.0.0` | `127.0.0.1` |
| Transport | TLS (via Tailscale Serve) | **cleartext** | cleartext (adb tunnel, never leaves the cable) |
| First pairing | Desktop QR / pairing link | Desktop QR (points at the LAN IP) | Desktop **USB pair** button, auto-launches the app via `mybuddy://pair` deep link |
| Dependencies | Tailscale on both devices | Same subnet | USB cable + `adb` + USB debugging authorized |
| Security | High | Medium — see warning below | High (physical cable) |
| Auto-discovery | not used | mDNS, UDP 3353 fallback | not used |

## Channel 1: Tailscale HTTPS (recommended)

1. Install Tailscale on Windows and Android and sign both devices into the same tailnet.
2. In MyBuddy, open **Settings → Security Center → Android / Mobile Remote**.
3. Enable Remote Access, keep the default port (3352) unless it conflicts, and enter the HTTPS address shown by Tailscale Serve as the base URL.
4. Run the command shown by MyBuddy, normally:

   ```powershell
   tailscale serve --bg 3352
   ```

5. Select **Add device**, then scan the QR code or copy the one-time pairing link into the Android app.

Do not enable Tailscale Funnel. The server binds loopback only in this mode and does not need a Windows Firewall inbound rule.

## Channel 2: LAN HTTP

1. In the same settings panel, switch binding from **This PC only** to **LAN** (`bindMode: lan`). The server then binds `0.0.0.0` and answers on every private IPv4 address on port 3352.
2. Pair from the desktop as usual; the QR/link points at the LAN address.
3. After the first pairing, the Android app discovers the host automatically via mDNS (with a UDP broadcast on port 3353 as fallback) and reconnects with zero input. Discovery is only a convenience for **already-paired** devices — first-time pairing always requires a desktop-generated credential.

**Warning:** this channel is plaintext HTTP. The device token and all conversation content (tool output, file paths) travel unencrypted on the local network and can be sniffed or ARP-spoofed. Prefer the Tailscale or USB channel whenever possible; use LAN mode only on networks you trust.

## Channel 3: USB direct

1. Connect the phone over USB with USB debugging enabled and `adb` available on the host.
2. In the settings panel pick the device and press the **USB pair** button. MyBuddy then:
   - runs `adb reverse tcp:<port> tcp:<port>` to map the host's loopback port onto the phone,
   - verifies the Android app is installed (`pm path`),
   - launches it with the pairing deep link (`am start -W -d <pairingUrl>`).
3. Any failed step rolls the reverse tunnel back.

The credential stored over USB uses `http://127.0.0.1:<port>`, which stops working the moment the cable is unplugged. When the phone later discovers the host on LAN, it reuses the **same token** against the LAN address — USB pairing once, LAN connectivity afterwards.

Note: reverse mappings are not torn down automatically on unplug today; run `adb reverse --remove-all` to clear them if you switch phones or ports.

## Prompt capabilities

The remote composer is wired end-to-end: the model picker lists the host's actually available models (fetched from `/v1/bootstrap`), the tool-access mode (`default` / `readonly` / `auto`) is forwarded per prompt only when the phone explicitly overrides it (otherwise the task's own mode is kept), and up to 4 attachments (≤ ~3 MB each, base64, 17 MB request cap) are persisted under `~/.mybuddy/remote-uploads/<taskId>/` on the host before the prompt runs; the directory is removed when the task is purged or a new remote task fails to start. Requests with unknown fields are rejected (`zod` strict mode).

## ACP external agents on the phone

The phone can hand a turn to an **ACP (Agent Client Protocol) external agent** — Codex, Claude, OpenCode, Devin, etc. — while the process, session and workspace authority stay on the Windows host.

| Route | Purpose |
|---|---|
| `GET /v1/acp/agents[?refresh=1]` | ACP catalog. Disabled agents (desktop *Settings → ACP management*) are omitted; installed-but-missing CLIs stay listed with `available: false` and a `detail` reason. `refresh=1` re-probes the host CLIs. Each entry carries its `permissionPolicy`. |
| `POST /v1/acp/agents/:id/permission` | `{ policy: "ask" \| "auto-allow" \| "auto-deny" }` → updated catalog. Writes host settings; the next permission request honours it (no restart). |
| `POST /v1/tasks/:id/acp` | `{ agentId, text, attachments?, continueFromRunId?, newSession? }` → `202` with the run projection. Starts a real ACP subprocess in the task's canonical workspace. |

### Permission policy (why it no longer stops on every step)

ACP agents ask the client for permission before most tool calls. By default (`ask`) each
request blocks the run until a human answers — fine for one-off edits, unusable for long
unattended runs. Per agent the host stores one of:

| Policy | Behaviour |
|---|---|
| `ask` (default) | Emit the approval card (`approvalKind: "acp"`), run goes `blocked`, wait for `optionId`. |
| `auto-allow` | Pick the agent's own `allow_*` option (prefers `allow_once`, falls back to `allow_always`) and answer immediately. No card, run never blocks; the call is still recorded in the timeline as **已按策略自动放行**. |
| `auto-deny` | Pick the agent's `reject_*` option; the tool lands `denied`. Useful for read-only analysis runs. |

Safety rules: the host never invents an option — if the agent offers no matching
`allow_*`/`reject_*`, the policy falls back to `ask`; unknown/corrupt values also normalize to
`ask`. The policy is read on every request, so changing it (desktop *ACP management* or the
phone's ACP sheet) applies to the next call without restarting the agent.

Behaviour that differs from the built-in Pi path:

- **One live run per task.** A second delegation while a run is `starting`/`working`/`blocked` returns `409` — two agents must never edit the same directory concurrently.
- **`busy` includes ACP.** Task rows and `GET /v1/tasks/:id/runtime` report `busy: true` and expose `acpRun` while the agent runs, so the phone replaces *send* with *stop*.
- **Permissions are agent-defined.** ACP permission requests surface in `runtime.pendingActions` with `approvalKind: "acp"` plus `acpRunId` and `acpPermissionOptions` (`allow_once` / `allow_always` / `reject_*`). The phone must answer with `POST /v1/tasks/:id/actions/:toolCallId/respond { decision, optionId }`; an unknown or expired option is rejected (`400` / `409`) instead of being silently treated as *deny*.
- **History is merged.** Completed runs live in `external_agent_runs`, not the Pi session file; `/history` merges both and tags the assistant message with an `acp: { runId, agentId, status, resumeSupported, verificationStatus }` projection. No host paths (`cwd`) are ever projected.
- **Continuation is automatic and scoped.** Every turn starts a *new* ACP subprocess (the process is disposable), but the **session** is resumed by default: the host picks the same task's latest run of the same agent that established a resumable session *and* whose cwd still equals the task's canonical root. Anything else falls back to a fresh session (`continuationMode: "new"`) instead of failing the send. Pass `newSession: true` to deliberately drop the context for one turn (the phone exposes this as a one-shot row in the ACP sheet); the flag resets after that turn. An explicit `continueFromRunId` still wins when supplied.
- **Stop cancels both chains.** `POST /v1/tasks/:id/abort` cancels the ACP subprocess as well as the built-in Pi turn.
- **The desktop sees phone turns live.** A phone-initiated run has no Pi patch stream, so the renderer now backfills the task's history on the first unknown ACP `assistantMessageId` (see `hydrateExternalAgentHistory` in `appStore.ts`). Without it, ACP events were only applied to messages the desktop had already loaded, and a turn started from the phone stayed invisible on the PC until the task was reopened. The phone also remembers the chosen agent per task in local storage, so an app restart no longer silently falls back to the built-in runtime.

The phone UI mirrors this: an ACP pill in the composer opens the agent picker (data from `bootstrap.acpAgents`, with a *re-probe* row), the selected agent is sticky for the task, and ACP permission prompts render one button per agent-declared option.

## Browser-origin policy (CSRF)

Write requests carry an Origin check (403 otherwise). Allowed origins: the Capacitor WebView (`capacitor://localhost`), localhost/loopback on the exact server port, same-port private-IPv4 origins in LAN mode, and the configured base URL origin (Tailscale Serve). Requests without an Origin header (native shells, curl) pass through; CORS headers are only echoed for allowed origins — never reflected blindly.

## Device security

- Pairing secrets expire after five minutes, are single-use, and void after five failed attempts.
- Each phone receives a different high-entropy device token. The host stores only its SHA-256 hash.
- Pairing is idempotent per installation: re-pairing the same install (`installationId`) rotates the token instead of adding a duplicate device row.
- Android stores the credential encrypted with an AES key protected by Android Keystore.
- Browser development mode uses session storage only and is not the production credential path.
- Revoke a lost phone from the paired-device list (or from the phone itself via *device → revoke*). Its next API request or SSE reconnect receives `401`.

## Troubleshooting

- `401`: the device token is missing, invalid, or revoked. Pair again from the desktop.
- `403 origin_forbidden`: the request reached the server from a browser origin outside the allow list — check the base URL setting and that the port matches.
- Page does not open: confirm MyBuddy Remote is running; for Tailscale, check both devices are connected and `tailscale serve status` lists the port; for LAN, check you are on the same subnet; for USB, check `adb devices` shows the phone as `device` (not `unauthorized`).
- Pairing link expired: close the old pairing panel and create a new one.
- Stream reconnects repeatedly: bring the app to the foreground; it reconnects with bounded backoff (1 s → 15 s) and requests a fresh snapshot when replay is no longer available.
- LAN discovery finds nothing: mDNS may be blocked by the router; the UDP 3353 fallback only works on the same subnet, and candidates are re-verified against `/healthz` before use.
