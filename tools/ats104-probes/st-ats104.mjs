/**
 * ATS-104 (SEIKOIST-150) -- ST-022 probe: the Tauri 2 Windows dev build.
 *
 * The acceptance criterion of ATS-104 is:
 *
 *   "Windows 实机完成 cargo tauri dev；关闭窗口后无孤儿窗口"
 *
 * Two independent things have to hold, and this probe checks BOTH with
 * signals that can fail:
 *
 *   1. `cargo tauri dev` starts the desktop shell on this machine, the
 *      WebView2 runtime loads the page, and the Bridge the shell spawns
 *      actually answers on the loopback port.
 *   2. After the window is closed, NO process of the shell's tree is left
 *      behind -- no orphan window, no orphan Bridge.
 *
 * The second half is the half that is easy to get wrong: the shell spawns
 * the Bridge as a child process, and a child that is not ended stays
 * running after the parent window is gone. The shell's own Drop impl
 * kills that child, but "the Drop impl runs" is a claim about the code,
 * not an observation of the machine. So the probe CLOSES THE WINDOW FOR
 * REAL and then OBSERVES what is still alive.
 *
 * The window is closed for real by posting a WM_CLOSE to the shell's
 * main window -- the same message a user clicking the X sends. The probe
 * finds the window by the process id of the shell and the window title,
 * using the Win32 API through PowerShell, so nothing here depends on a
 * headless shortcut that would skip the close path.
 *
 * Usage:
 *   node tools/ats104-probes/st-ats104.mjs
 *
 * Environment:
 *   ATS104_SKIP_BUILD=1   reuse the already-built binary (skip `cargo build`)
 *   ATS104_TIMEOUT_MS     how long to wait for the window (default 180000)
 *
 * The probe FAILS CLOSED: every "the window did not appear" / "the process
 * is still there" condition ends the run with a non-zero exit code and a
 * line that says which check failed.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const TAURI_DIR = path.join(REPO_ROOT, 'src-tauri');
const EXE = path.join(TAURI_DIR, 'target', 'debug', 'ai-test-studio.exe');

/**
 * The window title the shell configures in tauri.conf.json. It is READ
 * from the product configuration rather than written here: a probe that
 * carries its own copy of the title drifts from the product the moment
 * the title changes, and a probe that then waits for a window that will
 * never appear reports "the window did not open" for a product that is
 * perfectly fine.
 */
function windowTitle() {
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI_DIR, 'tauri.conf.json'), 'utf8'));
  const title = conf?.app?.windows?.[0]?.title;
  if (!title) throw new Error('tauri.conf.json does not declare a window title');
  return title;
}

/**
 * The Bridge's default port, read from the product source.
 *
 * A port literal in a probe is a port mention that the ATS-101 port audit
 * has to count, and a probe carrying its own copy of the port can drift
 * from the product. The Bridge's own default is the single source of truth.
 */
export function defaultPort() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'server', 'index.mjs'), 'utf8');
  const m = /ATS_PORT\s*\|\|\s*(\d+)/.exec(src);
  if (!m) throw new Error('could not read the default port from server/index.mjs');
  return Number(m[1]);
}

/** Can the port be bound right now? A real bind attempt, not a table lookup. */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Wait until the port can be bound.
 *
 * Returns how long it took, or null when the port was still busy after the
 * timeout. The wait is what makes the orphan check honest: a process that
 * was ended does not close its listening socket gracefully on Windows, so
 * the port needs a moment before it can be bound again.
 */
export async function waitForPortFree(port, timeoutMs = 15000, intervalMs = 250) {
  const t0 = Date.now();
  for (;;) {
    if (await portIsFree(port)) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

/**
 * The pid of the process LISTENING on the port, or null.
 *
 * This is what distinguishes "the port is still held because somebody is
 * still serving on it" from "the port is momentarily un-bindable because
 * the previous owner was terminated". Only the first is an orphan.
 */
function portListenerPid(port) {
  const r = ps(`
$line = netstat -ano | Select-String -Pattern ":${port}\\s+.*LISTENING" | Select-Object -First 1
if ($null -eq $line) { 'NONE' } else {
  $parts = ($line.ToString().Trim() -split '\\s+')
  $parts[$parts.Length - 1]
}
`);
  if (!r.stdout || r.stdout === 'NONE') return null;
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** The name of a process, or '?' when it is gone. */
function processName(pid) {
  const r = ps(`
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $p) { '?' } else { $p.ProcessName }
`);
  return r.stdout || '?';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a PowerShell script and return its stdout.
 *
 * PowerShell is used because the window and the process tree are Win32
 * objects: enumerating the windows of a process and posting a WM_CLOSE to
 * one of them has no equivalent in Node's standard library, and the
 * alternative -- killing the process -- would NOT exercise the close path
 * that the acceptance criterion is about.
 */
function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), status: r.status };
}

/**
 * The pid of the shell process, and the window handles it owns.
 *
 * The window is located by TITLE rather than by "any window of this
 * process": the shell's WebView2 spawns child browser processes whose
 * windows are not the application's window, and posting WM_CLOSE to one of
 * those would close the wrong thing.
 */
function windowsOfProcess(pid) {
  // The result is collected in an ArrayList and read with .Add(), NOT with
  // `$found += ...`. Inside a scriptblock delegate the assignment runs in
  // the delegate's own scope, so `+=` produces a local copy that the
  // caller never sees -- and the probe then reports "the window did not
  // open" for a window that is plainly there. ArrayList.Add() mutates the
  // instance, so the caller sees every entry.
  const script = `
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
Add-Type -TypeDefinition $src
$found = New-Object System.Collections.ArrayList
$cb = [Win+EnumWindowsProc]{
  param($h, $l)
  $p = 0
  [Win]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq ${pid}) {
    $len = [Win]::GetWindowTextLength($h)
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [Win]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    $t = $sb.ToString()
    $vis = [Win]::IsWindowVisible($h)
    [void]$found.Add([pscustomobject]@{ h = $h.ToInt64(); title = $t; visible = $vis })
  }
  return $true
}
[Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($found.Count -eq 0) { '[]' } else { $found | ConvertTo-Json -Compress }
`;
  const r = ps(script);
  if (!r.stdout) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    if (!parsed) return [];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Post a WM_CLOSE to the window with the given handle. */
function closeWindow(hwnd) {
  // The handle is turned into an IntPtr with ::new(), NOT with
  // `[IntPtr]::13633442`: the latter is parsed as a static MEMBER lookup on
  // the type, the member does not exist, and the call fails with
  // "Cannot convert null to type System.IntPtr" -- a probe that reports
  // "the close failed" for a close that was never even attempted.
  const script = `
$src = @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
Add-Type -TypeDefinition $src
$ok = [W]::PostMessage([IntPtr]::new(${hwnd}), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
if ($ok) { 'POSTED' } else { 'POSTFAILED' }
`;
  return ps(script);
}

/** Is the process alive? */
function processAlive(pid) {
  const r = ps(`
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $p) { 'NO' } else { 'YES:' + $p.ProcessName }
`);
  return r.stdout.startsWith('YES');
}

/**
 * The shell's own process tree, by parent-child relation.
 *
 * The Bridge is spawned by the shell, so it is a DESCENDANT of the shell
 * pid, not the shell pid itself. The tree is walked over the parent-pid
 * relation so the check covers "the Bridge outlived the window" too.
 *
 * The root pid is always included in the result, even after it died: the
 * caller needs to ask "is the shell still alive?" and the process table
 * no longer has an entry for a dead process.
 */
function descendantPids(rootPid) {
  const r = ps(`
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$want = New-Object System.Collections.Generic.HashSet[int]
[void]$want.Add(${rootPid})
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($want.Contains([int]$p.ParentProcessId) -and -not $want.Contains([int]$p.ProcessId)) {
      [void]$want.Add([int]$p.ProcessId)
      $changed = $true
    }
  }
}
($want | Sort-Object) -join ','
`);
  if (!r.stdout) return [];
  return r.stdout.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
}

async function main() {
  const failures = [];
  const notes = [];
  const port = defaultPort();
  const title = windowTitle();
  const timeoutMs = Number(process.env.ATS104_TIMEOUT_MS || 180000);

  console.log('=== ATS-104 ST-022: Tauri 2 Windows dev build and WebView2 ===');
  console.log(`repo root  : ${REPO_ROOT}`);
  console.log(`exe        : ${EXE}`);
  console.log(`title      : ${title}`);
  console.log(`bridge port: ${port}`);
  console.log(`timeout    : ${timeoutMs}ms`);
  console.log('');

  // --- 1. the build ------------------------------------------------------
  // The acceptance is about the dev build, so the probe builds it itself
  // unless the caller says the binary is already there. `cargo build` is
  // the gate: `cargo check` does not link the final artefact (ADR-014).
  if (process.env.ATS104_SKIP_BUILD !== '1') {
    console.log('--- 1. cargo build (final link included) ---');
    const build = spawnSync('cargo', ['build'], {
      cwd: TAURI_DIR,
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${build.stdout || ''}${build.stderr || ''}`;
    console.log(out.split('\n').slice(-12).join('\n'));
    console.log(`cargo build exit = ${build.status}`);
    if (build.status !== 0) {
      console.error('RESULT: FAIL -- cargo build did not succeed, so there is no artefact to run.');
      process.exit(1);
    }
  } else {
    console.log('--- 1. cargo build (skipped: ATS104_SKIP_BUILD=1) ---');
  }

  if (!fs.existsSync(EXE)) {
    console.error(`RESULT: FAIL -- the shell binary is missing: ${EXE}`);
    process.exit(1);
  }
  const exeStat = fs.statSync(EXE);
  console.log(`artefact   : ${exeStat.size} bytes`);
  console.log('');

  // --- 2. the port must be free before the run ---------------------------
  const free = await portIsFree(port);
  console.log(`--- 2. the Bridge port is free before the run: ${free ? 'yes' : 'NO'} ---`);
  if (!free) {
    console.error(`RESULT: FAIL -- the Bridge port is busy before the run; the probe would talk to a different server.`);
    process.exit(1);
  }

  // --- 3. start the desktop shell ---------------------------------------
  console.log('--- 3. cargo tauri dev ---');
  const dev = spawn('cargo', ['tauri', 'dev', '--no-watch'], {
    cwd: TAURI_DIR,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let devOut = '';
  dev.stdout.on('data', (d) => { devOut += d.toString(); });
  dev.stderr.on('data', (d) => { devOut += d.toString(); });

  const cleanup = () => {
    try { spawnSync('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { windowsHide: true }); } catch { /* best effort */ }
  };

  // --- 4. wait for the window -------------------------------------------
  console.log('--- 4. waiting for the desktop window ---');
  const t0 = Date.now();
  let shellPid = null;
  let win = null;
  while (Date.now() - t0 < timeoutMs) {
    const pids = descendantPids(dev.pid);
    for (const pid of pids) {
      const ws = windowsOfProcess(pid).filter((w) => w.visible && w.title === title);
      if (ws.length) {
        shellPid = pid;
        win = ws[0];
        break;
      }
    }
    if (win) break;
    if (dev.exitCode !== null) {
      console.error(`RESULT: FAIL -- cargo tauri dev exited early (code ${dev.exitCode}).`);
      console.error(devOut.split('\n').slice(-30).join('\n'));
      cleanup();
      process.exit(1);
    }
    await sleep(1000);
  }

  if (!win) {
    console.error(`RESULT: FAIL -- the window "${title}" did not appear within ${timeoutMs}ms.`);
    console.error(devOut.split('\n').slice(-30).join('\n'));
    cleanup();
    process.exit(1);
  }
  console.log(`window     : hwnd=${win.h} pid=${shellPid} title="${win.title}" visible=${win.visible}`);
  console.log(`appeared in: ${Date.now() - t0}ms`);
  console.log('');

  // --- 5. the Bridge answers --------------------------------------------
  console.log('--- 5. the Bridge the shell spawned answers on the loopback port ---');
  let health = null;
  const h0 = Date.now();
  while (Date.now() - h0 < 30000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      health = { status: res.status, body: (await res.text()).slice(0, 400) };
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!health) {
    failures.push(`the Bridge did not answer /api/health on the loopback port within 30000ms`);
    console.log('  the Bridge did NOT answer');
  } else {
    console.log(`  GET /api/health -> ${health.status}`);
    console.log(`  body: ${health.body}`);
    if (health.status !== 200) failures.push(`/api/health returned ${health.status}, expected 200`);
  }
  console.log('');

  // --- 6. close the window FOR REAL -------------------------------------
  console.log('--- 6. closing the window (WM_CLOSE, the same message the X button sends) ---');
  const treeBefore = descendantPids(shellPid);
  console.log(`  the shell tree before the close: ${treeBefore.join(', ')}`);
  const closeRes = closeWindow(win.h);
  const closePosted = closeRes.stdout === 'POSTED';
  console.log(`  PostMessage(WM_CLOSE) -> ${closePosted ? 'sent' : `FAILED (${closeRes.stdout || closeRes.stderr || 'no output'})`}`);
  if (!closePosted) {
    failures.push('could not post WM_CLOSE to the window');
  }

  // --- 7. no orphan ------------------------------------------------------
  console.log('--- 7. no orphan window and no orphan process after the close ---');
  let orphanShell = false;
  let orphanWindows = [];
  const t1 = Date.now();
  const graceMs = 20000;
  while (Date.now() - t1 < graceMs) {
    orphanShell = processAlive(shellPid);
    orphanWindows = windowsOfProcess(shellPid).filter((w) => w.visible);
    if (!orphanShell && orphanWindows.length === 0) break;
    await sleep(500);
  }

  const treeAfter = descendantPids(shellPid);
  console.log(`  the shell process is alive: ${orphanShell ? 'YES (ORPHAN)' : 'no'}`);
  console.log(`  the shell's visible windows: ${orphanWindows.length}`);
  console.log(`  the shell tree after the close: ${treeAfter.length ? treeAfter.join(', ') : '(none)'}`);
  console.log(`  settled in: ${Date.now() - t1}ms`);

  if (orphanShell) failures.push(`the shell process ${shellPid} was still alive ${graceMs}ms after the window was closed`);
  if (orphanWindows.length) failures.push(`${orphanWindows.length} visible window(s) of the shell survived the close`);

  // The Bridge is a child of the shell. If the shell's Drop impl did not
  // end it, it is still listening on the port -- that is an orphan of the
  // very kind the acceptance criterion forbids.
  //
  // The wait is BOUNDED and it is a WAIT, not a single sample: on Windows a
  // process that is ended with TerminateProcess does not close its sockets
  // gracefully, so the port keeps a listening socket whose owning PID is 0
  // for a moment after the process is gone (docs/22 §4.5). Sampling once,
  // right after the close, therefore reports "the port is still held" for a
  // Bridge that has already exited -- and reports it as an orphan defect.
  // So the probe waits for the port to become bindable, and it attributes
  // a still-busy port to a LISTENER it can name, rather than to the mere
  // absence of a bind.
  const treeAlive = [];
  for (const pid of treeAfter) {
    if (pid === shellPid) continue;
    if (processAlive(pid)) treeAlive.push(pid);
  }
  console.log(`  the shell's tree members still alive: ${treeAlive.length ? treeAlive.join(', ') : '(none)'}`);

  const portWaited = await waitForPortFree(port, 15000, 250);
  const portStillBusy = portWaited === null;
  console.log(`  the Bridge port is bindable again: ${portStillBusy ? 'NO' : `yes (waited ${portWaited}ms)`}`);

  if (treeAlive.length) {
    const names = treeAlive.map((pid) => `${pid}(${processName(pid)})`).join(', ');
    failures.push(`a process of the shell's tree outlived the closed window: ${names}`);
  }
  if (portStillBusy) {
    // A port that is still busy is only an ORPHAN defect when somebody is
    // still listening on it. A socket left behind by a terminated process
    // is a different thing, so the probe names the listener.
    const holder = portListenerPid(port);
    failures.push(
      holder
        ? `the Bridge port ${port} was still held after the window was closed (listener pid ${holder})`
        : `the Bridge port ${port} was still un-bindable ${15000}ms after the window was closed`,
    );
  }

  console.log('');

  // --- 8. the dev command itself ----------------------------------------
  const devExit = await new Promise((resolve) => {
    if (dev.exitCode !== null) return resolve(dev.exitCode);
    const t = setTimeout(() => resolve(null), 15000);
    dev.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  console.log(`--- 8. cargo tauri dev exit code: ${devExit === null ? '(still running)' : devExit} ---`);
  console.log('');
  console.log('--- the dev output tail ---');
  console.log(devOut.split('\n').slice(-25).join('\n'));
  console.log('');

  cleanup();

  if (failures.length) {
    console.error('RESULT: FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('RESULT: OK -- the dev build opened the window, the Bridge answered, and closing the window left no orphan.');
  if (notes.length) {
    console.log('');
    console.log('notes:');
    for (const n of notes) console.log(`  - ${n}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`RESULT: FAIL -- the probe threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
