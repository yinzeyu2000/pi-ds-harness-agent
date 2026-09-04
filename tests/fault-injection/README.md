# Fault-injection suite

Deterministic cut points cover before/after Journal append and flush, before/after model/tool/process dispatch, partial stream/output, process exit, approval response, projection update, publish, unload, and restart. Each scenario asserts replay state, allowed retry behavior, and absence of duplicate non-idempotent effects.
