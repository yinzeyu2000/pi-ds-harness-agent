# M0 baseline results

Captured on Windows with Node.js 22.20.0 and npm 10.9.3.

| Check | Result | Notes |
|---|---|---|
| Dependency install | Pass | One optional Gondolin Node-engine warning. |
| Model-data hydration | Pass | 1,323 tool-capable model records generated. |
| Offline build | Pass | 15.90 seconds after hydration; needed normal host filesystem visibility for the final CLI bundle. |
| Upstream full test run | Environment-limited | Most suites pass. Failures cluster around missing auto-detected Git Bash, Windows symlink privileges, sandboxed home writes and local socket permissions; a few upstream assertions assume POSIX separators or mishandle a workspace path containing spaces. |
| `@pi-ds/harness-runtime` build | Pass | TypeScript declarations and JavaScript emitted. |
| `@pi-ds/harness-runtime` tests | Pass | 5 files, 12 tests, fully offline. |

The upstream test failures were present before new runtime behavior was connected and are not hidden or converted into skips. They form the Windows baseline for later compatibility work.

## Baseline constraints discovered

- The user-selected top-level directory contains spaces and `+`; subprocess construction must use argument arrays or correct quoting.
- Git Bash is installed outside Pi's two default Windows discovery paths.
- The managed test environment does not allow all symlink, home-directory and local-socket operations.
- Generated model data is required for an offline build but is ignored by the upstream repository.
