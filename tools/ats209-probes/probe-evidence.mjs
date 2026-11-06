/**
 * ATS-209 probe: MEASURE the evidence behaviour against the acceptance
 * criteria of the task.
 *
 *   1. 「篡改可检测」 -- a file that is changed after the run was archived
 *      is DETECTED, and the answer names the file and the two digests.
 *   2. 「保留期到期可清理且不误删 Run 元数据」 -- the cleaning removes the
 *      expired evidence and the RUN RECORD survives it, field for field.
 *   3. The deduplication stores the SAME bytes ONCE.
 *
 * THE PROBE ONLY OBSERVES. It prints what the code does, so the report says
 * what is true rather than what should be.
 *
 * THE NEGATIVE CONTROL
 * --------------------
 * A probe that only ever prints "PASS" cannot tell a working check from a
 * check that is vacuously true. So every detection claim here is measured
 * TWICE: once against the real code (which must detect) and once against a
 * DELIBERATELY BROKEN copy (which must NOT detect). A check that passes on
 * both is not a check at all, and the probe says so.
 *
 * The broken copy is a THROWAWAY: the real source files are never
 * modified.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildManifest, cleanRunEvidence, collectEvidence, expiredRuns,
  MAX_EVIDENCE_ENTRIES, sha256OfFile, sha256OfText, verifyEvidence,
} from '../../server/evidence/manifest.mjs';
import {
  cleanExpiredEvidence,
} from '../../server/evidence/retention.mjs';
import {
  linkToBlob, storeBlob, storeBytes, storeDirOf,
} from '../../server/evidence/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats209-probe-'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('=== ATS-209 probe: the evidence manifest and the retention policy ===');
console.log(`tree : ${root}`);
console.log('');

/**
 * A run folder with evidence, a record and a manifest.
 */
function makeRunFolder(files = {}) {
  const folder = fs.mkdtempSync(path.join(dir, 'run-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(folder, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return folder;
}

const makeRun = (overrides = {}) => ({
  id: 'run_1_000000000000000000000000',
  projectUid: 'proj_1_000000000000000000000000',
  projectId: 'proj_1_000000000000000000000000',
  gitCommit: 'abc1234',
  runner: 'playwright',
  status: 'passed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:10:00.000Z',
  attempts: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
console.log('--- 1. the manifest names the run and carries the digests ---');
{
  const folder = makeRunFolder({
    'report.json': '{"ok":true}',
    'results/trace.zip': 'TRACE',
    'events.jsonl': '{"seq":1}\n',
    'stdout.log': 'raw output',
  });
  const run = makeRun();
  const manifest = buildManifest(run, folder);
  check('the manifest names the run', manifest.runId === run.id, `runId=${manifest.runId}`);
  check('the manifest names the project', manifest.projectUid === run.projectUid);
  check('the manifest names the commit', manifest.sourceCommit === run.gitCommit);
  check('the manifest has an evidence section', Boolean(manifest.evidence?.setDigest));
  const files = manifest.artifacts.map((a) => a.file).sort();
  check(
    'the manifest lists the evidence and nothing else',
    JSON.stringify(files) === JSON.stringify(['report.json', 'results/trace.zip']),
    files.join(', ')
  );
  const digestsOk = manifest.artifacts.every(
    (a) => a.sha256 === sha256OfFile(path.join(folder, a.file))
  );
  check('every digest is the digest of the file\'s real bytes', digestsOk);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 2. TAMPERING IS DETECTED ---');
{
  const folder = makeRunFolder({ 'report.json': '{"ok":true}' });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(buildManifest(makeRun(), folder)));

  // The intact archive verifies.
  const intact = verifyEvidence(folder);
  check('the intact archive verifies', intact.verified === true,
    `verified=${intact.verified} missing=${intact.missing.length} changed=${intact.changed.length}`);

  // The tamper: the archived file is rewritten.
  fs.writeFileSync(path.join(folder, 'report.json'), '{"ok":false}');
  const tampered = verifyEvidence(folder);
  check('the tampered archive does NOT verify', tampered.verified === false);
  check('the tampered file is named', tampered.changed.length === 1 && tampered.changed[0].file === 'report.json',
    JSON.stringify(tampered.changed.map((c) => c.file)));
  check('both digests are reported',
    tampered.changed[0]?.expected === sha256OfText('{"ok":true}')
    && tampered.changed[0]?.actual === sha256OfText('{"ok":false}'));

  // A deleted file is MISSING, not changed.
  const folder2 = makeRunFolder({ 'report.json': '{}', 'results/trace.zip': 'TRACE' });
  fs.writeFileSync(path.join(folder2, 'manifest.json'), JSON.stringify(buildManifest(makeRun(), folder2)));
  fs.rmSync(path.join(folder2, 'results', 'trace.zip'));
  const deleted = verifyEvidence(folder2);
  check('a deleted file is reported as missing',
    deleted.missing.length === 1 && deleted.missing[0] === 'results/trace.zip'
    && deleted.changed.length === 0);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 3. THE NEGATIVE CONTROL: a broken check detects nothing ---');
{
  // A copy of the manifest module whose verification ALWAYS says "verified".
  // The real source is NOT touched: the copy is written into the scratch
  // directory and imported from there.
  const src = fs.readFileSync(path.join(root, 'server', 'evidence', 'manifest.mjs'), 'utf8');
  // The line that decides whether the archive is intact. It is matched by
  // its NAME, not by its exact text, so a refactoring of the expression
  // does not silently turn the control into "the control could not be
  // built" -- a control that cannot be built proves nothing.
  const decided = /const verified = [^;]+;/m;
  const broken = src.replace(decided, 'const verified = true;');
  if (broken === src) {
    check('the negative control could not be built', false, 'the verification line was not found');
  } else {
    const brokenPath = path.join(dir, 'broken-manifest.mjs');
    fs.writeFileSync(brokenPath, broken);
    // The copy is imported by its file:// URL: a Windows absolute path is
    // not a valid ESM specifier.
    const brokenModule = await import(pathToFileURL(brokenPath).href);
    const folder = makeRunFolder({ 'report.json': '{"ok":true}' });
    // The manifest is a REAL manifest -- built by the real module -- so the
    // control compares two verifications of the SAME archive. A control
    // whose fixture is broken would pass for the wrong reason.
    fs.writeFileSync(
      path.join(folder, 'manifest.json'),
      JSON.stringify(buildManifest(makeRun(), folder))
    );
    fs.writeFileSync(path.join(folder, 'report.json'), 'TAMPERED');
    const result = brokenModule.verifyEvidence(folder);
    check('the broken verification does NOT detect the tampering', result.verified === true,
      'a check that passes on a broken copy is not a check');
    check('the real verification DOES detect it', verifyEvidence(folder).verified === false);
  }
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 4. THE CLEANING DOES NOT DELETE THE RUN METADATA ---');
{
  const folder = makeRunFolder({
    'report.json': '{}',
    'results/trace.zip': 'TRACE',
    'events.jsonl': '{"seq":1,"type":"run.queued"}\n',
    'stdout.log': 'raw output',
  });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(buildManifest(makeRun(), folder)));

  // The run record: status, summary, attempts, events. It lives in the
  // state, not in the run folder.
  const run = makeRun({
    summary: { passed: 2, failed: 0, skipped: 0, flaky: 0, total: 2, executions: 2, cases: [] },
    attempts: [
      { uid: 'att_1_000000000000000000000000', status: 'passed', retry: 0 },
      { uid: 'att_1_000000000000000000000001', status: 'passed', retry: 1 },
    ],
    events: [
      { seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'run.queued', data: {} },
      { seq: 2, at: '2026-01-01T00:01:00.000Z', type: 'run.started', data: {} },
      { seq: 3, at: '2026-01-01T00:10:00.000Z', type: 'run.finished', data: { status: 'passed' } },
    ],
  });
  const before = JSON.stringify(run);

  const expired = expiredRuns([run], { days: 1, now: Date.parse('2026-06-01T00:00:00.000Z') });
  check('the old terminal run is expired', expired.length === 1, `expired=${expired.length}`);

  const result = cleanExpiredEvidence({
    runs: [run],
    folderOf: () => folder,
    days: 1,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
  });
  check('the cleaning ran', result.ok === true && result.cleaned.length === 1);

  // The evidence is gone.
  check('the evidence was removed',
    !fs.existsSync(path.join(folder, 'report.json'))
    && !fs.existsSync(path.join(folder, 'results', 'trace.zip')));

  // The run's own record files stay.
  check('the event log stays', fs.existsSync(path.join(folder, 'events.jsonl')));
  check('the raw output stays', fs.existsSync(path.join(folder, 'stdout.log')));
  check('the manifest stays', fs.existsSync(path.join(folder, 'manifest.json')));

  // The run record is byte-identical.
  check('the run record is byte-identical after the cleaning', JSON.stringify(run) === before);
  check('the run still has its status', run.status === 'passed');
  check('the run still has its summary', run.summary?.total === 2);
  check('the run still has its attempts', run.attempts.length === 2);
  check('the run still has its events', run.events.length === 3);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 5. THE CLEANING IS REFUSED WHILE THE BRIDGE HOLDS THE DIRECTORY ---');
{
  const folder = makeRunFolder({ 'report.json': '{}' });
  const run = makeRun({ status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' });
  const result = cleanExpiredEvidence({
    runs: [run],
    folderOf: () => folder,
    days: 1,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    lockHeld: true,
  });
  check('the cleaning is refused', result.ok === false);
  check('nothing was removed', fs.existsSync(path.join(folder, 'report.json')));
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 6. THE SAME BYTES ARE STORED ONCE ---');
{
  const storeRoot = fs.mkdtempSync(path.join(dir, 'store-'));
  const storeDir = storeDirOf(storeRoot);
  const fileA = path.join(storeRoot, 'a.json');
  const fileB = path.join(storeRoot, 'b.json');
  fs.writeFileSync(fileA, 'THE SAME CONTENT');
  fs.writeFileSync(fileB, 'THE SAME CONTENT');
  const digest = sha256OfText('THE SAME CONTENT');

  const first = storeBlob(storeDir, fileA, digest);
  const second = storeBlob(storeDir, fileB, digest);
  check('the first copy is stored', first.stored === true && first.alreadyStored === false);
  check('the second copy finds the stored one', second.alreadyStored === true);
  check('both point at the same blob', first.path === second.path);
  const bytes = storeBytes(storeDir);
  check('the store holds the bytes ONCE', bytes === 'THE SAME CONTENT'.length,
    `store holds ${bytes} bytes`);

  // The run file becomes a link to the stored copy.
  const linked = linkToBlob(fileA, first.path);
  check('the run file is linked to the stored copy', linked.linked === true);
  const sameInode = fs.statSync(fileA).ino === fs.statSync(first.path).ino;
  check('the two paths are the same inode', sameInode);
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 7. THE EVIDENCE SET IS WHAT THE MANIFEST DESCRIBES ---');
{
  const folder = makeRunFolder({ 'report.json': '{}', 'results/a.png': 'PNG' });
  const entries = collectEvidence(folder);
  const manifest = buildManifest(makeRun(), folder);
  check('the collected entries and the manifest agree',
    JSON.stringify(entries) === JSON.stringify(manifest.artifacts));
}

// ---------------------------------------------------------------------------
console.log('');
console.log('--- 8. THE REVIEW ROUND 1 PROPERTIES ---');
{
  // E1: a blob whose content was tampered with is NOT reused.
  const storeRoot = fs.mkdtempSync(path.join(dir, 'store-e1-'));
  const storeDir = storeDirOf(storeRoot);
  const file = path.join(storeRoot, 'report.json');
  fs.writeFileSync(file, 'GENUINE');
  const digest = sha256OfText('GENUINE');
  const first = storeBlob(storeDir, file, digest);
  // The tamper: the blob is a hard link to the run file, so an in-place
  // write to the run file changes the blob too.
  fs.writeFileSync(first.path, 'TAMPERED');
  fs.writeFileSync(file, 'GENUINE');
  const second = storeBlob(storeDir, file, digest);
  check('a tampered blob is not reused (E1)',
    fs.readFileSync(second.path, 'utf8') === 'GENUINE',
    `the blob holds ${JSON.stringify(fs.readFileSync(second.path, 'utf8'))}`);

  // E3: a manifest entry outside the run folder is refused, not followed.
  const folder = makeRunFolder({ 'report.json': '{}' });
  const outside = path.join(dir, 'outside-e3.json');
  fs.writeFileSync(outside, 'NOT THIS RUN\'S EVIDENCE');
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
    version: 2,
    runId: makeRun().id,
    artifacts: [
      { file: 'report.json', size: 2, sha256: sha256OfText('{}') },
      { file: '../outside-e3.json', size: 20, sha256: sha256OfFile(outside) },
    ],
  }));
  const verified = verifyEvidence(folder);
  check('an entry outside the run folder is refused (E3)',
    verified.verified === false && verified.rejected.length === 1,
    `rejected=${JSON.stringify(verified.rejected)}`);
  const cleaned = cleanRunEvidence(folder);
  check('the cleaning does not reach outside the run folder (E3)',
    fs.existsSync(outside) === true && cleaned.rejected.length === 1);

  // E6: a manifest that hit the entry limit says so and does not verify.
  const big = makeRunFolder({});
  for (let i = 0; i < MAX_EVIDENCE_ENTRIES + 10; i++) {
    fs.writeFileSync(path.join(big, `f-${String(i).padStart(4, '0')}.txt`), `c ${i}`);
  }
  const bigManifest = buildManifest(makeRun(), big);
  check('a manifest that hit the entry limit records it (E6)',
    bigManifest.evidence.truncated === true && bigManifest.artifacts.length === MAX_EVIDENCE_ENTRIES);
  fs.writeFileSync(path.join(big, 'manifest.json'), JSON.stringify(bigManifest));
  const bigVerified = verifyEvidence(big);
  check('a manifest that does not cover the folder does not verify (E6)',
    bigVerified.verified === false && bigVerified.truncated === true);

  // E7: evidence removed by the retention policy is not a tamper.
  const cleanedFolder = makeRunFolder({ 'report.json': '{}', 'results/trace.zip': 'TRACE' });
  fs.writeFileSync(path.join(cleanedFolder, 'manifest.json'),
    JSON.stringify(buildManifest(makeRun(), cleanedFolder)));
  cleanRunEvidence(cleanedFolder);
  const afterClean = verifyEvidence(cleanedFolder);
  check('a cleaned run is not reported as tampered (E7)',
    afterClean.verified === true && afterClean.missing.length === 0
    && afterClean.cleaned.length > 0,
    `verified=${afterClean.verified} cleaned=${afterClean.cleaned.length}`);

  // E7 negative control: a file that vanishes WITHOUT a cleaning record.
  const vanished = makeRunFolder({ 'report.json': '{}' });
  fs.writeFileSync(path.join(vanished, 'manifest.json'),
    JSON.stringify(buildManifest(makeRun(), vanished)));
  fs.rmSync(path.join(vanished, 'report.json'));
  const afterVanish = verifyEvidence(vanished);
  check('a file that vanishes without a cleaning record is still a tamper (E7)',
    afterVanish.verified === false && afterVanish.missing.length === 1);

  // E4: the cleaning reports only what it actually removed.
  const alreadyGone = makeRunFolder({ 'report.json': '{}' });
  fs.writeFileSync(path.join(alreadyGone, 'manifest.json'),
    JSON.stringify(buildManifest(makeRun(), alreadyGone)));
  fs.rmSync(path.join(alreadyGone, 'report.json'));
  const secondClean = cleanRunEvidence(alreadyGone);
  check('the cleaning reports only the files it actually removed (E4)',
    secondClean.removed.length === 0,
    `removed=${JSON.stringify(secondClean.removed)}`);
}

console.log('');
console.log(`RESULT: ${failures === 0 ? 'OK' : 'MISMATCH'} -- ${failures} failure(s)`);
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
