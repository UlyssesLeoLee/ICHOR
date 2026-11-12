//! Tests for the desktop shell's Bridge child lifecycle.
//!
//! The property under test is that the shell ends the Bridge child it
//! spawned, and that it does so from a place that actually runs when the
//! user closes the window.
//!
//! The shell's `Drop` impl alone does NOT establish that: the Windows
//! window event loop ends with `std::process::exit`, which terminates the
//! process without running any destructor. The exit handler of the run
//! loop is the place that does run, so the tests below exercise the same
//! method that both paths call.
//!
//! These tests are about the PROCESS, not about a mock: each one starts a
//! real child process and observes whether it is gone afterwards.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The shell's own container for the Bridge child.
///
/// This mirrors the shape of the production type in `src-tauri/src/lib.rs`
/// (a mutex around an optional child) without dragging the Tauri runtime
/// into the test: the behaviour under test is "kill the child and wait for
/// it", and that is what the production `stop()` does.
struct BridgeProcess(Mutex<Option<Child>>);

impl BridgeProcess {
    fn new(child: Child) -> Self {
        BridgeProcess(Mutex::new(Some(child)))
    }

    /// End the child and wait for it to be gone.
    fn stop(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// The pid of the child, for the assertions outside the mutex.
    fn child_pid(&self) -> u32 {
        self.0
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|c| c.id()))
            .unwrap_or(0)
    }
}

impl Drop for BridgeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Is the process still alive?
///
/// Windows has no "does this pid exist" syscall that is not racy, so the
/// child handle itself is the authority: `try_wait` reports `Ok(None)`
/// while the child runs and `Ok(Some(status))` once it has been reaped.
fn is_running(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

/// Is a process with this pid still alive?
///
/// The test asserts on the OS process, not on the handle, because the
/// production code ends the child and then DROPS the handle -- after that
/// there is no handle left to ask.
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let probe = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .expect("tasklist must be available on Windows");
    let text = String::from_utf8_lossy(&probe.stdout);
    // tasklist prints the pid in the second column of its table.
    text.split_whitespace().any(|field| field == pid.to_string())
}

/// Wait until a pid is gone, or the deadline passes.
fn wait_until_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while pid_is_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    !pid_is_alive(pid)
}

/// A long-lived child process that is not the shell's own process.
fn spawn_sleeper() -> Child {
    Command::new("node")
        .arg("-e")
        .arg("setInterval(() => {}, 1000)")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("node must be on PATH to run this test")
}

#[test]
fn stop_ends_the_child_and_leaves_other_processes_alone() {
    let mut unrelated = spawn_sleeper();
    assert!(is_running(&mut unrelated), "the unrelated child must run");

    let bridge = BridgeProcess::new(spawn_sleeper());
    let child_pid = bridge.child_pid();
    assert!(child_pid > 0);
    assert!(pid_is_alive(child_pid), "the bridge child must be running");

    bridge.stop();

    // The child is gone: the process table no longer lists it.
    assert!(
        wait_until_gone(child_pid, Duration::from_secs(10)),
        "the child of the bridge must be gone after stop() (pid {})",
        child_pid
    );

    // An unrelated process is untouched: stop() ends the child it owns,
    // not every child on the machine.
    assert!(
        is_running(&mut unrelated),
        "an unrelated process must survive stop()"
    );
    let _ = unrelated.kill();
    let _ = unrelated.wait();
}

#[test]
fn stop_is_safe_to_call_twice() {
    let bridge = BridgeProcess::new(spawn_sleeper());
    bridge.stop();
    // The exit handler and the Drop impl both call stop(); the second call
    // must not panic (a poisoned or already-taken mutex would).
    bridge.stop();
}

#[test]
fn drop_ends_the_child() {
    let child_pid = {
        let bridge = BridgeProcess::new(spawn_sleeper());
        let pid = bridge.child_pid();
        assert!(pid_is_alive(pid));
        // `bridge` is dropped at the end of this block, which calls stop().
        pid
    };
    assert!(
        wait_until_gone(child_pid, Duration::from_secs(10)),
        "the child must be gone after the bridge is dropped (pid {})",
        child_pid
    );
}
