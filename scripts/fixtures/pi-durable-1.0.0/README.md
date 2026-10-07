# Pi Durable 1.0.0 storage compatibility fixture

These JSONL files were generated with the unmodified published
`@earendil-works/pi-durable@1.0.0` from the official npm registry on 2026-10-07.
Its tarball SHA-512 integrity is
`sha512-PvjCIdy5jRsBoJDRpCCI0RfwBax2ZPnMT5aw/tRQxcQOqbGGj2mq1z0WuVxoyimWWi+WYSYT2VySg3RO1qzySw==`.

The fixture contains one completed reply, a run checkpointed while the unsafe
`legacy_hold` tool was executing, and one queued follow-up. The registry extension
was named `mybuddy.bot`; the model is the fixture-only `fixture/fixture`. No working
directory, credentials, user profile, or provider session UUID is embedded.

`test:durable-bot` copies this frozen store to an isolated temporary directory
before opening it with the current runtime. It checks committed history, queue
recovery, interruption reporting, zero side-effect replay and automatic native
provider session identity creation for the legacy conversation.
