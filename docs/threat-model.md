# Runtime threat model

## Security objective

The runtime must make policy, approval, side-effect, and persistence decisions auditable and race-safe. Secure profiles aim to contain untrusted model-generated commands; the Functional MVP makes no hostile-code isolation claim.

## Protected assets

User files outside granted roots, credentials and environment secrets, network identity, process/host integrity, canonical Thread history, approval intent, plugin supply chain, resource budgets, and control of an active Thread.

## Trust boundaries

Inputs from users, models, tools, plugins, MCP servers, files, network peers, and UI clients are untrusted. The security microkernel and platform adapters are the TCB. Same-process plugins are trusted code even when their data is not. Journal projections and UI caches are non-authoritative.

## Principal threats and required controls

| Threat | Required control |
| --- | --- |
| Prompt/tool injection reaches host resources | capability-scoped broker; canonical policy; secure sandbox; explicit approval |
| Path traversal, symlink/reparse escape, TOCTOU | canonical handles/paths; no-follow checks; platform-specific grant verification; race tests |
| Shell/argument confusion | structured executable/argv/env/cwd; no implicit shell; canonical display separate from execution |
| Secret theft or log leakage | allowlisted environment; redaction before durable/log/UI boundaries; secret taint tests |
| Sandbox silently unavailable | profile capability probe and fail-closed admission |
| Orphan or runaway processes | process-tree ownership, deadlines, output/resource limits, kill-and-reap settlement |
| Duplicate side effects after retry/crash | durable dispatch intent, attempt IDs, receipts, `outcome_unknown` for ambiguity |
| Approval replay or substitution | bind approval to principal, epoch, operation, canonical action hash, expiry, and one use |
| Stale UI/controller mutation | controller epoch, runtime generation, ordered mailbox, request dedupe |
| Journal tampering/torn writes | checksums, monotonic sequence, atomic segment protocol, recovery quarantine |
| Plugin authority escalation | host-issued capabilities only; plugins may narrow but not broaden; architecture guards |
| Resource exhaustion | per-thread/process/stream limits, backpressure, fair scheduling, bounded queues |
| Confused-deputy model/provider access | ModelGateway ownership, provider policy, correlation and spend budgets |

## Non-claims at M0

No new runtime or sandbox is implemented in M0. Existing Pi tools and extensions retain their upstream security posture. Windows hostile-code isolation, remote multi-tenant isolation, untrusted same-process plugins, and perfect secret erasure are not claimed.

## Verification gates

Security claims require negative tests, escape attempts, fault injection at durability barriers, approval race/replay tests, process-tree cleanup, and platform capability reports. A security regression blocks Secure Beta even if functional tests pass.
