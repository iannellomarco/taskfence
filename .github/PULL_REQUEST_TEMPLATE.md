## Problem

Describe the observable defect or capability gap.

## Change

Explain the smallest complete change and the invariants it preserves.

## Verification

List focused commands and observed results. For behavioral changes, include the end-to-end scenario exercised.

## Security and compatibility

- [ ] Contract parsing remains strict and deterministic.
- [ ] Unknown or malformed mutations still fail closed.
- [ ] Human authority cannot be widened through an LLM-callable path.
- [ ] State, receipts, checkpoint, and rollback behavior remain crash-recoverable.
- [ ] Runtime payload and version assumptions are source-verified.
- [ ] Documentation and release artifacts are updated when public behavior changes.
