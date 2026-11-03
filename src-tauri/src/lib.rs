use std::{path::PathBuf,process::{Child,Command,Stdio},sync::Mutex};
use tauri::Manager;

struct BridgeProcess(Mutex<Option<Child>>);
impl Drop for BridgeProcess { fn drop(&mut self) { if let Ok(mut v)=self.0.lock() { if let Some(child)=v.as_mut() { let _=child.kill();let _=child.wait(); } } } }

#[tauri::command]
fn local_bridge_status() -> String { "local Node.js Playwright runner required".into() }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
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
    .run(tauri::generate_context!())
    .expect("error while running AI Test Studio");
}
