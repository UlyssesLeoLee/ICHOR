# Technical Design: `src-tauri/src/lib.rs`

Source: `src-tauri/src/lib.rs`

Source-SHA256: `9196ee861711d0fc77d9ab29d054ff5fd8d45075182f154f892b9d280b48c0e2`

## Responsibility

The Tauri 2 desktop shell: it starts the Node.js Bridge (`server/index.mjs`) as a child process, exposes one command (`local_bridge_status`), and owns the lifecycle of that child.

Two things in this file decide whether the acceptance criterion 「关闭窗口后无孤儿窗口」 holds:

- **who ends the Bridge child**, and
- **which crate types the library is built as** (`src-tauri/Cargo.toml`).

## Dependencies

- Upstream: `tauri` 2.12.5 (`Builder`, `App`, `AppHandle`, `Manager`, `RunEvent`), the standard library (`std::process`, `std::sync::Mutex`, `std::path::PathBuf`).
- Downstream: `src-tauri/src/main.rs` (calls `run()`); `src-tauri/Cargo.toml`; the `cargo tauri dev` / `cargo build` pipeline; `tools/ats104-probes/st-ats104.mjs` (the ST-022 probe that observes this file's behaviour on a real machine).

## Public Contract

- `pub fn run()` — the entry point. Builds the application, starts the Bridge in `setup`, and runs the event loop.
- `fn local_bridge_status() -> String` — a Tauri command returning a fixed status string.
- `struct BridgeProcess(Mutex<Option<Child>>)` — the managed state holding the Bridge child.

### The Bridge child is ended in TWO places, and the second one is the one that runs

The shell ends the Bridge child from `BridgeProcess::stop()`:

1. from the `Drop` impl, and
2. from the `RunEvent::Exit` handler of the Tauri run loop.

Both call the same method, so the child is ended exactly once either way.

**The `Drop` impl alone is not enough on Windows.** The Windows window event loop
(`tao-0.37.2`, `platform_impl/windows/event_loop.rs`) ends with
`::std::process::exit(exit_code)`. That terminates the process **without running any
destructor**, so a `Drop` impl never runs on the normal "the user closed the window"
path. A child that is only ended by `Drop` therefore stays alive after the window is
gone, and a port it holds stays held.

`RunEvent::Exit` IS delivered on that path: `tauri-runtime-wry` maps the event loop's
`Event::LoopDestroyed` to `RunEvent::Exit`, and the Windows event loop emits
`LoopDestroyed` **before** it calls `std::process::exit`. Ending the child there is
therefore the last point at which the shell can still end it.

`stop()` kills the child and then waits for it, so the caller knows the child is gone
when `stop()` returns.

### The child is started with the Bridge's own port

The child is started as `node <repo>/server/index.mjs` with `ATS_PORT` set, and with
its stdout and stderr on `null`. A failed spawn is discarded (`spawn().ok()`), which
means "no Bridge" is a state the shell tolerates — the Bridge being absent is reported
through `local_bridge_status`, not through the spawn result.

## Change Notes

- The `RunEvent::Exit` handler was added to the run loop, and `BridgeProcess::stop()`
  was extracted from the `Drop` impl so both paths end the child the same way. The
  application is now built with `Builder::build` and then run with `App::run`, because
  the run loop's callback is the only place the exit event can be observed.
- The crate type lives in `src-tauri/Cargo.toml`: the `cdylib` artefact is not
  consumed by any target in this repository, and a `cdylib` on the
  `x86_64-pc-windows-gnu` toolchain exports every reachable symbol of the whole
  dependency tree into the PE export directory, which assigns one 16-bit ordinal per
  exported symbol. The export table of a Tauri 2 dependency tree exceeds the 65535
  ordinal limit and the final link fails. `staticlib` and `rlib` carry no PE export
  table. See `docs/16-BASELINE-ADR.md` §4 B-02.

## Verification

- `cargo build` (the final link, not a type check) succeeds and produces
  `src-tauri/target/debug/ai-test-studio.exe`.
- `tools/ats104-probes/st-ats104.mjs` starts the shell for real, closes the window for
  real, and observes that no process of the shell's tree survives and that the Bridge
  port becomes bindable again. Evidence: `docs/evidence/ATS-104/`.
- The same probe rejects a mutated copy of this file whose exit handler does not end
  the Bridge (the negative control), which is what makes the pass meaningful.
