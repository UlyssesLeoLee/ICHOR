# Technical Design: `server/control-plane/boundary.mjs`

Source: `server/control-plane/boundary.mjs`

Source-SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Responsibility

Pure, side-effect-free boundary rules of the deployable control-plane API (ATS-506, `docs/21-CONTROL-PLANE-API.md` §5). It decides whether a string has a local path form, whether a field name smuggles a local path, repository address or credential, and whether a value has the shape of the desktop Bridge session token. It walks request bodies and response bodies with the same rules, so ingress and egress share one definition.

## Dependencies

- Upstream: none except the JavaScript runtime (no `node:` module at all; no filesystem, network or process access).
- Downstream: `server/control-plane/app.mjs` (ingress pipeline steps 2/11/12/13 and egress step 17), `tests/control-plane.test.mjs` (UT-CP-001..007).
- Protocol source of the rules: `docs/19-REMOTE-RUNNER-PROTOCOL.md` HB-2/HB-3/HB-4/HB-7, §9.

## Public Contract

- `detectLocalPath(text) -> string | null`: returns the rule name of the first matching local path form (`windows_drive_path`, `unc_path`, `posix_absolute_path`, `file_url`, `home_relative_path`, `env_path`, `path_traversal`, `repository_url`) or `null`. The string is checked as-is and, when it percent-decodes, decoded. Non-strings return `null`.
- `isLocalSessionTokenShape(text) -> boolean`: true for exactly 48 hexadecimal characters.
- `classifyField(name) -> {code, kind} | null`: normalises the field name (drop `_`/`-`, lower case) and returns `REMOTE_PATH_FORBIDDEN` with `path_field` or `repository_url_field`, `REMOTE_SECRET_INLINE_FORBIDDEN` with `credential_field`, or `null`.
- `inspectValue(value, {maxDepth = 32}) -> {code, kind, pointer} | null`: depth-first walk over objects and arrays; keys are checked by `classifyField` and `detectLocalPath`, string values by `detectLocalPath` and `isLocalSessionTokenShape`. `pointer` is a JSON-pointer-like location (`/a/0/b`), never the offending value. Depth beyond `maxDepth` returns `REMOTE_POLICY_REJECTED` with kind `depth_exceeded`.
- `LOCAL_CREDENTIAL_HEADERS`: the header names of the local Bridge credential (`x-ats-token`), which the control plane refuses.
- Invariants: the functions never throw for any JSON value; the returned finding never contains the input text.

## Change Notes

New module for ATS-506. No existing behaviour changes: the local Bridge does not import it. Rules are heuristics documented in `docs/21-CONTROL-PLANE-API.md` §11 item 4; egress scanning is the second line of defence.
