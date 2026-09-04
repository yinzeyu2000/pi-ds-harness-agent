# Architecture guards

`check-m0-baseline.mjs` is the first executable guard. Later guards will reject:

- direct provider calls outside ModelGateway adapters;
- direct process spawning outside ProcessManager platform adapters;
- Journal implementation imports outside runtime persistence boundaries;
- sandbox implementation imports outside its capability interface;
- transport/UI mutation that bypasses AgentHarness and the ThreadRuntime mailbox;
- plugin capabilities broader than their host-issued manifest grants;
- dependency cycles from the microkernel into UI, transport, or plugin implementations.

Guards are additive and run in CI. Exceptions require an ADR and a narrow allowlist entry with an owner and expiry.
