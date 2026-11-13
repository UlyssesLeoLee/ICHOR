use std::{path::PathBuf,process::{Child,Command,Stdio},sync::Mutex};
use tauri::Manager;

/// The Node.js Bridge process the desktop shell starts.
///
/// The child is held behind a mutex because the shell has to end it from two
/// places: the exit event of the Tauri run loop and the `Drop` impl below.
struct BridgeProcess(Mutex<Option<Child>>);

impl BridgeProcess {
  /// End the Bridge process and wait for it to be gone.
  ///
  /// This is the method the run loop's exit event calls, and it is the ONLY
  /// reliable place to end the child on Windows: the window event loop exits
  /// through `std::process::exit`, which terminates the process without
  /// running any destructor. A `Drop` impl therefore never runs on the normal
  /// "the user closed the window" path, and a child that is only ended by
  /// `Drop` stays alive after the window is gone.
  fn stop(&self) {
    if let Ok(mut guard)=self.0.lock() {
      if let Some(child)=guard.as_mut() {
        let _=child.kill();
        let _=child.wait();
      }
    }
  }
}

impl Drop for BridgeProcess {
  fn drop(&mut self) { self.stop(); }
}

#[tauri::command]
fn local_bridge_status() -> String { "local Node.js Playwright runner required".into() }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app=tauri::Builder::default()
    .setup(|app| {
      let root=PathBuf::from(env!("CARGO_MANIFEST_DIR"));
      let script=root.join("../server/index.mjs");
      // Developer/portable mode: Node.js >=22 needs to be installed. A bundled sidecar is a P1 item.
      let child=Command::new("node")
        .arg(script)
        .env("ATS_PORT","4577")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn().ok();
      app.manage(BridgeProcess(Mutex::new(child)));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![local_bridge_status])
    .build(tauri::generate_context!())
    .expect("error while building AI Test Studio");
  // `RunEvent::Exit` is delivered while the event loop is still running (it
  // is emitted for the loop-destroyed event, which the Windows event loop
  // emits BEFORE it calls `std::process::exit`). Ending the Bridge here is
  // therefore the last point at which the shell can still end its child.
  app.run(|app_handle,event| {
    if let tauri::RunEvent::Exit=event {
      if let Some(bridge)=app_handle.try_state::<BridgeProcess>() {
        bridge.stop();
      }
    }
  });
}
