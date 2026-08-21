# MCP glasses display (private evaluation)

Status: private evaluation only. Public MCP/skill publication and operational
authorization remain NO-GO until the gates in
`notes/mcp-glasses-display-threat-model-2026-08-21.md` pass.

## Safe defaults

- Proactive bridge calls are disabled by default. Enable **Allow proactive Hermes
  actions** only for a deliberate, trusted evaluation and disable it afterward.
- `glasses.show_alert` accepts at most 160 characters of inert plain text. It
  rejects control characters, markup delimiters, and URLs. It never wakes an
  unavailable/off display, and reports success only after the shell transport
  completion boundary. Transport completion is not evidence that pixels reached
  real G2 lenses.
- The bridge token is configuration, not a publication credential. Never put it
  in source, screenshots, bug reports, or logs. Use a replacement-only update
  and treat Android backup/ADB access as local secret exposure.
- Model output, tool results, notifications, calendar, media, and window data
  are untrusted or private. Do not paste them into release artifacts.

## Configuration and permissions

The phone-side assistant is configured in Settings under Assistant. The external
mode requires a bridge host, port, and shared token. The client now requires a
certificate-validated `wss://` endpoint, but the available sibling bridge/server
has not been shown to provide that endpoint or server identity proof; external
operation therefore remains disabled/NO-GO.
Only grant Android runtime permissions for features you use. Keep Even installed
for provisioning and official maintenance; Hermes does not replace Even's
ownership or firmware responsibilities.

## Tool boundary

The phone exposes versioned MCP lifecycle methods and a registry of currently
available tools. Every call is schema-checked, availability-checked, and subject
to duplicate-request and proactive-rate gates. The current flagship display
surface is the bounded `glasses.show_alert` control; `glasses.render_view` is not
implemented and must not be advertised.

## Troubleshooting and disable/rollback

If a call reports that the display is unavailable, reconnect the provisioned G2
through the normal app flow; do not pair, reset, flash, or change ownership to
recover it. If the bridge behaves unexpectedly, turn off **Allow proactive Hermes
actions**, switch the assistant backend away from external mode, or clear the
bridge host/token settings. Uninstalling is not required to disable the bridge.

Testing so far is static/unit and debug-build evidence only. A32-only or simulated
results do not prove real-G2 lens visibility, generic MCP interoperability, secure
transport, or public release readiness. Hardware-only checks must be run with a
reproducible device/log/screenshot record before those claims are made.