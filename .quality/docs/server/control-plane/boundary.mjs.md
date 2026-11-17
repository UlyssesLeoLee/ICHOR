# Technical Design: `server/control-plane/boundary.mjs`

Source: `server/control-plane/boundary.mjs`

Source-SHA256: `4be3a578aa106a3e121900a999d4abed2a03e4efc34e70a8d562370066daa38a`

## Responsibility

Pure, side-effect-free boundary rules of the deployable control-plane API (ATS-506, `docs/21-CONTROL-PLANE-API.md` §5). It decides whether a string has a local path form, whether a field name smuggles a local path, repository address or credential, and whether a value has the shape of the desktop Bridge session token. It walks request bodies and response bodies with the same rules, so ingress and egress share one definition.

## Dependencies

- Upstream: none except the JavaScript runtime (no `node:` module at all; no filesystem, network or process access).
- Downstream: `server/control-plane/app.mjs` (ingress pipeline steps 2/11/12/13 and egress step 17), `tests/control-plane.test.mjs` (UT-CP-001..007).
- Protocol source of the rules: `docs/19-REMOTE-RUNNER-PROTOCOL.md` HB-2/HB-3/HB-4/HB-7, §9.

## Public Contract

- `detectLocalPath(text) -> string | null`: returns the rule name of the first matching local path form (`windows_drive_path`, `windows_rooted_path`, `unc_path`, `posix_absolute_path`, `file_url`, `home_relative_path`, `env_path`, `path_traversal`, `repository_url`) or `null`. The string is checked as-is and, when it percent-decodes, decoded. Non-strings return `null`.
- `isLocalSessionTokenShape(text) -> boolean`: true for a string that contains a standalone run of exactly 48 hexadecimal characters (not adjacent to further hex digits), at any position. `Bearer <token>`, `x-ats-token=<token>` and a bare token all match; 40/64/96-hex digests do not.
- `env_path` covers any environment reference (`$NAME`, `${NAME}`, `$env:NAME`, `%NAME%` with a name of at least 3 characters) AND, independently of the name length, a `%NAME%` reference of ANY length that is immediately followed by a path separator (`%CD%\repo`, `%CD%/repo`, `%OS%\x`). The separator rule is what catches the short built-in variables: `%CD%` is the current directory in cmd, i.e. a local absolute path. A `%NAME%` reference of any length that is NOT followed by a separator stays allowed, so the percent-encoded fragments of a UTF-8 text (`%E4%B8%AD`) are not mistaken for a path; `home_relative_path` also covers `~user/`; `windows_drive_path` also covers drive-relative `D:work`; `windows_rooted_path` covers a leading single backslash and backslash-separated multi-segment text.
- `posix_absolute_path` covers a system root that follows ANY character outside `[A-Za-z0-9._-]` -- not only whitespace, quotes, parentheses, equals, comma, semicolon and colon. The narrower character class let a system root survive behind `[`, a backtick, `{`, `<` and `|`, which is why `[/home/alice/repo]`, `` `/home/alice/repo` ``, `{/Users/bob/x}`, `</etc/passwd>`, `|/var/log/x` and `dir:[/home/a]` were accepted. A system root that follows a letter, a digit, a dot, an underscore or a hyphen is still NOT a path (`https://h/home/x`, `TCP/IP`, `a.b/home`), because in those positions the text is part of a host, a protocol or an identifier rather than a path.
- `classifyField(name) -> {code, kind} | null`: normalises the field name (drop `_`/`-`, lower case) and returns `REMOTE_PATH_FORBIDDEN` with `path_field` or `repository_url_field`, `REMOTE_SECRET_INLINE_FORBIDDEN` with `credential_field`, or `null`.
- `inspectValue(value, {maxDepth = 32, fieldNames = true}) -> {code, kind, pointer} | null`: depth-first walk over objects and arrays; keys are checked by `detectLocalPath`/`isLocalSessionTokenShape` and, when `fieldNames` is true (ingress), by `classifyField`; string values by `detectLocalPath` and `isLocalSessionTokenShape`. Egress passes `fieldNames: false` because a response may legitimately name a concept such as `credential`; only values are judged there. `pointer` is a JSON-pointer-like location (`/a/0/b`); an offending key is located by its index (`/a/#2`), so the pointer never repeats the offending text. Depth beyond `maxDepth` returns `REMOTE_POLICY_REJECTED` with kind `depth_exceeded`.
- `LOCAL_CREDENTIAL_HEADERS`: the header names of the local Bridge credential (`x-ats-token`), which the control plane refuses.
- Invariants: the functions never throw for any JSON value; the returned finding never contains the input text.

## Change Notes

New module for ATS-506. No existing behaviour changes: the local Bridge does not import it. Rules are heuristics documented in `docs/21-CONTROL-PLANE-API.md` §11 item 3. Egress scanning uses the same judgement as ingress, so it catches values that re-enter a response, not forms ingress does not know. Review round 1 found embedded tokens, environment variables and several Windows path forms slipping through; they are covered by UT-CP-031..034 and IT-CP-014.

Review round 2 (Opus) found two path counterexamples that survived round 1's rules:

1. the short environment variables `%CD%` / `%OS%` followed by a separator were accepted, because round 1 had replaced "a `%NAME%` of any length followed by a separator" with "a `%NAME%` of at least 3 characters" and dropped the separator rule with it. `%CD%` is the current directory in cmd -- a local absolute path. The separator rule comes back, and the name length only decides whether a `%NAME%` reference is refused ON ITS OWN;
2. a POSIX system root behind `[`, a backtick, `{`, `<` or `|` was accepted, because the leading character class was narrower than `docs/21` §5.1 documents. The class is widened to "any character outside `[A-Za-z0-9._-]`".

Both are locked by UT-CP-035 (round-2 regression cases) and guarded by mutation M12 (delete the separator rule) and M13 (narrow the leading character class back).
