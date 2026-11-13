# Test Design: `src-tauri/src/lib.rs`

Source: `src-tauri/src/lib.rs`

Source-SHA256: `9196ee861711d0fc77d9ab29d054ff5fd8d45075182f154f892b9d280b48c0e2`

## Test Strategy

The behaviour under test is a **process-lifecycle** property: after the desktop
window is closed, no process of the shell's tree is left behind. That cannot be
asserted from inside the process — a `Drop` impl's behaviour is a claim about the
code, not an observation of the machine. It is therefore tested from the outside:

- the **real shell** is started with `cargo tauri dev`;
- the **real window** is closed for real (a `WM_CLOSE` posted to the main window —
  the same message the X button sends);
- the **process table** is then observed.

The probe is **fail-closed**: the window not appearing, the Bridge not answering, a
process of the shell's tree outliving the closed window, and a Bridge port that stays
held are all non-zero exits naming the failing check.

A probe that always passes would look like a delivery, so the probe is checked by a
**negative control**: the same probe is run against a mutated COPY of the product
whose exit handler does not end the Bridge. The control must fail **on the orphan
check** — a control that fails earlier (no artefact, no window) has not exercised the
check it is meant to prove.

| Layer | What it mutates | What it proves |
| --- | --- | --- |
| 1 -- the probe | nothing (the delivered product) | the acceptance criterion holds on a real machine |
| 2 -- the negative control | a COPY of `src-tauri/src/lib.rs` whose `RunEvent::Exit` handler no longer ends the Bridge | the orphan check rejects a product that leaves the child behind |

## Test Cases

| Case ID | Input / Setup | Expected Outcome | Test Location |
| --- | --- | --- | --- |
| TC-001 | `cargo build` in `src-tauri/` (the final link, not a type check) | exit code 0; `src-tauri/target/debug/ai-test-studio.exe` exists | `src-tauri/tests/bridge_lifecycle.rs` |
| TC-002 | `cargo tauri dev` started by the probe | a visible window titled as `tauri.conf.json` declares appears, and the probe reports its handle and its pid | `src-tauri/tests/bridge_lifecycle.rs` |
| TC-003 | the shell is up | the Bridge the shell spawned answers `GET /api/health` on the loopback port with 200 | `src-tauri/tests/bridge_lifecycle.rs` |
| TC-004 | the probe posts `WM_CLOSE` to the main window | the shell process is gone, the shell has no visible window left, and no process of the shell's tree is still alive | `src-tauri/tests/bridge_lifecycle.rs` |
| TC-005 | after the close | the Bridge port can be bound again (a real `bind()`, not a socket-table lookup) | `src-tauri/tests/bridge_lifecycle.rs` |
| TC-006 | the negative control: a COPY of the product whose exit handler does not end the Bridge | the probe fails **on the orphan check** and names the surviving process; the control is reported OK only when the failure is on that check | `src-tauri/tests/bridge_lifecycle.rs` |
| TC-007 | `cargo test --test bridge_lifecycle` | the unit tests of the child lifecycle pass: `stop()` ends the child it owns, a second `stop()` does not panic, `Drop` ends the child, and an unrelated process survives | `src-tauri/tests/bridge_lifecycle.rs` |

## Boundary & Failure Cases

- **The window never appears** → the probe exits non-zero with "the window ... did not
  appear within <timeout>ms" and prints the dev command's output tail. It is a FAIL,
  never a skip.
- **The Bridge does not answer within 30s** → the probe records the failure and exits
  non-zero. The window may still be up; that does not make the run a pass.
- **`/api/health` answers with a non-200** → recorded as a failure naming the status.
- **The port was already busy before the run** → the probe refuses to start ("the
  Bridge port is busy before the run; the probe would talk to a different server").
  Without that check a PASS could come from a Bridge that was already running.
- **The port stays un-bindable after the close** → the probe distinguishes the two
  causes: a socket left behind by a terminated process (whose owning pid is 0) is not
  an orphan, while a port that still has a LISTENING socket is. The failure message
  names the listener's pid when there is one.
- **The negative control fails for an unrelated reason** (its artefact is missing, its
  window did not open) → the control is reported `INCONCLUSIVE`, not `OK`: it did not
  exercise the check it is meant to prove.
- **The build fails** → the collector writes the full build output and the run is not
  reported as a pass. A type check is never accepted in place of a build.
- **The msvc toolchain** → not exercised here at all: the machine has no MSVC C++
  build tools workload, so the conclusions of these cases are about the gnu chain.
  That boundary is stated in the evidence README, not glossed over.

## Regression Scope

- `src-tauri/Cargo.toml` — the crate types decide whether the final link succeeds at
  all; a `cdylib` re-added there makes TC-001 fail with
  `export ordinal too large: <n>`.
- `src-tauri/src/main.rs` — calls `run()`; unchanged.
- `src-tauri/tauri.conf.json` — the window title and the `beforeDevCommand` the
  probe depends on.
- `server/index.mjs` — the Bridge the shell starts; its `/api/health` route is what
  TC-003 observes.
- `apps/studio` — the Next app the shell loads; its dev server is what the WebView2
  loads.

## Evidence

`docs/evidence/ATS-104/` — `01-cargo-build.log`, `02-st-022-probe.log`,
`03-negative-control.log`.
