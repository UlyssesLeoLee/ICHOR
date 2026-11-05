# Technical Design: `server/control-plane/errors.mjs`

Source: `server/control-plane/errors.mjs`

Source-SHA256: `16a362f39d141693d5443898b0c4cc9a4fd5224aeed7ab33079a6ffada672300`

## Responsibility

Single source of the control-plane rejection codes: HTTP status, retryability and the one-sentence actionable hint of every `REMOTE_` code in `docs/19-REMOTE-RUNNER-PROTOCOL.md` §6.2 / §10. It also defines the error type the pipeline throws and the fixed response body, so no handler can invent a code, echo an exception message or fall back to a local Bridge code.

## Dependencies

- Upstream: none (pure module).
- Downstream: `server/control-plane/app.mjs`, `server/control-plane/auth.mjs`; `tests/control-plane.test.mjs` UT-CP-008 compares the table with the machine-readable constraint block of `docs/19` so the two cannot drift.

## Public Contract

- `REMOTE_CODES`: frozen object `{code: {http, retryable, hint}}` with exactly the 25 codes of the `docs/19` constraint block.
- `class ControlPlaneError extends Error` with `code`, `http`, `retryable` and an optional audit-only `reason`; constructing it with a code outside `REMOTE_CODES` throws `TypeError` (programming error, never a client response).
- `errorBody(code) -> {error, hint, retryable}`: the only shape an error response may have. It carries no request data, path, stack or exception message.
- Invariant: every code starts with `REMOTE_`; none equals a local Bridge code (`INVALID_SESSION`, `ORIGIN_NOT_ALLOWED`, ...).

## Change Notes

New module for ATS-506. It implements ADR-019 (deny-by-default, `REMOTE_POLICY_REJECTED` vs `REMOTE_INTERNAL`) and ADR-021 (unified `REMOTE_UNAUTHENTICATED`) on the API side.
