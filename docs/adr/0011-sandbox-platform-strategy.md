# ADR-011: Sandbox platform strategy

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

The Functional MVP supports Windows and Linux process control, with no claim of hostile-code isolation. Linux is the first Secure Beta sandbox target because its filesystem, namespace, syscall, resource, and network controls can be composed and tested fail-closed without importing Codex's Rust core.

Windows remains a Tier-1 usability target and will use Job Objects, restricted-token/AppContainer or service-backed isolation experiments, explicit filesystem grants, and network controls. It may enter Secure Beta only after the same conformance and escape gates pass. A Codex-compatible native sidecar is a separately gated fallback, not the default architecture.

Every execution declares a sandbox profile and effective capabilities. If a required secure control is unavailable, secure profiles fail closed; they never silently downgrade. `danger-full-access` remains explicit and auditable.

## Consequences

Linux CI is the canonical full-suite and first security gate. Native Windows CI validates portability and process semantics, while security claims remain profile- and OS-specific.
