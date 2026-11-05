# Technical Design: `server/control-plane/auth.mjs`

Source: `server/control-plane/auth.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Responsibility

User-side authenticators of the control plane (`docs/21-CONTROL-PLANE-API.md` §6). An authenticator maps a request to `{subject, tenantId}` or refuses with an audit-only reason. The production authenticator (OIDC) belongs to ATS-507; this module provides the interface, the deny-all default and a loopback-only development authenticator used by the tests.

## Dependencies

- Upstream: `node:crypto` (SHA-256 digests and `timingSafeEqual` for constant-length comparison).
- Downstream: `server/control-plane/main.mjs` (selects the authenticator from `ATS_CP_AUTH`), `server/control-plane/app.mjs` (calls it), `tests/control-plane.test.mjs` UT-CP-010/011.

## Public Contract

- `denyAllAuthenticator()`: returns an authenticator whose result is always `{ok:false, reason:'missing_user_token' | 'unknown_user_token'}`.
- `staticBearerAuthenticator(map)`: `map` is `{token: tenantId}`; throws `TypeError` when the map is not a non-empty plain object, a token is shorter than 32 characters, or a tenant id does not match `^ten_[A-Za-z0-9_-]{1,64}$`. The authenticator reads only `Authorization: Bearer <token>`; a missing or non-Bearer header yields `missing_user_token`, an unknown token `unknown_user_token`; a match yields `{ok:true, subject:'dev:<8 hex of the token digest>', tenantId}`. Tokens are compared by SHA-256 digest with `timingSafeEqual`, so length and prefix do not short-circuit.
- `parseDevTokens(json)`: parses `ATS_CP_DEV_TOKENS` and applies the same validation; error messages name the problem, never the token value.
- Invariant: no authenticator ever accepts the local Bridge header `X-ATS-Token` (the pipeline rejects it before authentication).

## Change Notes

New module for ATS-506. `dev-static` is not a production authentication mode; `main.mjs` refuses it on non-loopback hosts.
