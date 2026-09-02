# Source-port ledger

| ID | Reference | Target | Method | Locking test |
|---|---|---|---|---|
| PORT-001 | DeepSeek Harness Cordis lifecycle concepts | `packages/harness-runtime/src/plugin-host.ts` | Clean-room interface and implementation: static manifest, dependency graph, reversible effects and LIFO disposal. No Cordis type or code is exposed. | `plugin-host.test.ts` |
| PORT-002 | DeepSeek Harness three event domains | `events.ts`, `projections.ts` | Conceptual adaptation using small project-owned APIs. | `events-and-session.test.ts` |
| PORT-003 | DeepSeek Harness Profile/Bundle/Patch model | `profile.ts` | Reduced startup-only pure composer with four explicit patch operations. | `profile-and-tools.test.ts` |
| PORT-004 | Pi Agent and Session APIs | `pi-agent-driver.ts`, `minimal-runtime.ts` | Direct imports from the retained Pi workspace; no copied implementation. | `vertical.test.ts` |

The Cordis decision remains reversible: the public types are project-owned, while the selected M1 implementation is the small self-contained host. A private Cordis adapter can be evaluated later against the same conformance tests.
