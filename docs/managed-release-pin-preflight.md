# Managed release trust-pin evidence verifier

`node scripts/verify-managed-release-pin.mjs --release <immutable-stage-directory> --catalog <Portal-trust-catalog.json> --repo <DeskCommand-repository> --proposal <pin-proposal.json>`

This is an **offline, read-only** preflight. It verifies the complete manifest digest, the proposal's exact source/digest, the source Git tree, stage and rollback SHA-256 inventories, and the Portal trust-catalog schema and uniqueness. It rejects symlinks, unsafe inventory paths, tampered files, conflicting or duplicate pin entries.

Exit codes: **0** means the exact pin is already present; **2** means the complete artifact is verified but an independently reviewed Portal pin is still missing; **3** means verification failed and must be investigated. Structured output is JSON. A verified pin is **not release-owner clearance** and does not establish admission freeze, client drain, a successful supervisor receipt, current running source, or native MCP acceptance.

The Portal catalog remains owned by the Portal release workstream. Do not use this script to modify it, bypass the independently supervised promotion, or merge candidate branches while an existing release-source hold remains. For changes to the Portal pin, use the existing Portal owner and its approved release process. Run focused regression checks with `node --test test/test-managed-release-pin.js`.
