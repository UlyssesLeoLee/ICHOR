# Technical Design: `server/control-plane/app.mjs`

Source: `server/control-plane/app.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Responsibility

The HTTP request handler of the deployable control-plane API `/cp/v1` (`docs/21-CONTROL-PLANE-API.md` §3/§4). It runs the ordered ingress pipeline (path and query scan, local credential refusal, Origin refusal, routing, authentication, tenant derivation, body limits and scan), serves the project-metadata resources by opaque UID inside the caller's tenant, and scans every response before it is sent (egress guard).

## Dependencies

- Upstream: `server/control-plane/boundary.mjs`, `server/control-plane/errors.mjs`, `node:crypto` (`randomUUID` for `prj_` identifiers). It does NOT import any local Bridge module (`server/index.mjs`, `server/core.mjs`, `server/agent.mjs`, `server/adapters/*`), Tauri, `node:fs` or `node:child_process`.
- Downstream: `server/control-plane/main.mjs` (wraps the handler in an HTTP/HTTPS server), `tests/control-plane.test.mjs` (in-process HTTP UT-CP-015..027/030), `tests/control-plane-it.test.mjs` (process-level IT-CP).

## Public Contract

- `createControlPlane({authenticate, authMode = 'none', now = () => new Date().toISOString(), newProjectUid, maxBodyBytes = 65536}) -> {handler(req, res), store, audit}`.
  - `handler` implements the routes `GET /cp/v1/health` (public), `GET /cp/v1/contract`, `GET|POST /cp/v1/projects`, `GET /cp/v1/projects/{projectUid}`; everything else is `403 REMOTE_POLICY_REJECTED`.
  - `store`: `Map<tenantId, Map<projectUid, {projectUid, displayName, createdAt}>>`, exposed for tests and for later persistence work; it never holds paths.
  - `audit`: array of `{at, tenantId, action, code, reason}` (capped at 1000 entries, oldest dropped).
- Responses: JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; errors are `errorBody(code)` only.
- Ordering and codes: exactly the 17 steps of `docs/21` §4; the egress guard turns a response that contains a local path form or local token shape into `500 REMOTE_INTERNAL` with audit reason `egress_boundary_blocked`.
- Invariants: tenant comes only from the authenticator; a client-supplied tenant (header `X-ATS-Tenant`, query `tenantId`, body `tenantId`) must equal it; a resource of another tenant is indistinguishable from a missing one (`404 REMOTE_RESOURCE_NOT_FOUND`).

## Change Notes

New module for ATS-506. Persistence, RBAC, OIDC, jobs and evidence endpoints are out of scope (ATS-502/503/507/508/509/511).
