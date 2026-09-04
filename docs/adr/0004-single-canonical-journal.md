# ADR-004: One canonical journal

- Status: Accepted
- Date: 2026-09-03
- Milestone: M0

## Decision

A Pi-derived append-only Journal is the sole physical source of durable facts. The Journal interface may have memory, JSONL, and future database implementations, but one Thread has exactly one selected canonical writer at a time.

SQLite, search indexes, UI caches, metrics, and snapshots are projections that can be discarded and rebuilt from the Journal. JSONL and SQLite must never be dual canonical stores. Snapshot metadata records its source event sequence and schema version.

## Consequences

All externally meaningful state transitions originate as Journal events. Recovery replays the Journal and verifies checksums/sequence continuity before accepting new work. Projection lag cannot redefine committed truth.
