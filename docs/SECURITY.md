# Security boundaries

- Reddit text, imported evidence, model output, and generated code are untrusted.
- Research models receive no tools and must return JSON Schema-constrained output.
- Builder tools can only read/search/patch allowlisted paths. Toolchain and configuration files are immutable.
- Generated code never executes in the control-plane process.
- The preview origin executes no generated server code. It serves only hash-verified static bytes through 15-minute HMAC URLs on a dedicated cookie-less hostname with a restrictive CSP, no-store responses, and bounded per-instance request throttling; production must add an edge rate limit.
- Signed verification binds the verified repository/source hash, server-capable release hash, and static preview hash. A preview is unavailable if any binding, signature, expiry, Build Output schema, object hash, or size check fails.
- Control-plane credentials cannot be granted to generated projects.
- Approval payloads bind exact project/spec/artifact/provider/secret versions and expire after one use.
- Logs, errors, events, analytics, and web responses pass through centralized secret redaction.
- Webhooks require signatures, a timestamp window, and replay protection.

Before enabling live integrations, complete threat modeling for prompt injection, command execution, SSRF, IDOR, duplicate spend, OAuth callback integrity, artifact traversal, and partial provider failures.
