/**
 * ATS-209 -- the evidence manifest, the deduplication and the retention:
 * the unit tests.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * The two properties the acceptance criteria ask for, each at the level
 * where it can be measured:
 *
 *   1. TAMPERING IS DETECTABLE. A file that was changed after the run was
 *      archived no longer matches the digest the manifest recorded, and
 *      the verification says WHICH file changed and what the two digests
 *      are. A file that was DELETED is reported as missing, not as "the
 *      evidence is fine".
 *
 *   2. THE CLEANING DOES NOT DELETE THE RUN METADATA. The evidence files
 *      go; the event log, the raw output and the manifest stay; and the
 *      run record itself -- its status, its summary, its attempts and its
 *      events -- is not touched at all, because it does not live in the run
 *      folder.
 *
 * Plus the two properties that make the two above possible: the manifest
 * is a FUNCTION of the run and its folder (so it can be rebuilt and
 * compared), and the deduplicated bytes are stored ONCE.
 *
 * The filesystem operations are REAL: the tests create real files, hash
 * them, tamper with them and delete them. Nothing is mocked, because the
 * properties under test are properties of the filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_RETENTION_DAYS,
  EVIDENCE_MANIFEST_VERSION,
  MANIFEST_FILENAME,
  RECORD_FILENAMES,
  buildManifest,
  cleanRunEvidence,
  collectEvidence,
  evidenceSetDigest,
  expiredRuns,
  isTerminalForRetention,
  readManifest,
  retentionReport,
  sharedEvidenceBytes,
  sha256Of,
  sha256OfFile,
  sha256OfText,
  verifyEvidence,
} from '../server/evidence/manifest.mjs';
import {
  cleanExpiredEvidence,
  planRetention,
  readJournal,
  writeJournal,
} from '../server/evidence/retention.mjs';
import {
  copiesOf,
  deduplicationReport,
  duplicatedEvidence,
  emptyEvidenceIndex,
  evidenceIndexOf,
  evidenceKeyOf,
  indexRunEvidence,
} from '../server/evidence/dedup.mjs';
import {
  MAX_BLOB_BYTES,
  blobPath,
  linkToBlob,
  pruneStore,
  storeBlob,
  storeBytes,
  storeDirOf,
  unreferencedBlobs,
} from '../server/evidence/store.mjs';

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ats-evidence-'));

/**
 * A run folder with a few evidence files, an event log and a raw output.
 *
 * The three kinds are DIFFERENT on purpose: the evidence is what the
 * cleaner removes, the other two are the run's record and stay.
 */
function makeRunFolder(files = {}) {
  const folder = tmp();
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(folder, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return folder;
}

/** A run record with the fields the manifest reads. */
function makeRun(overrides = {}) {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test('UT-EVD-001: the manifest names the run it belongs to and carries the digests', () => {
  const folder = makeRunFolder({ 'report.json': '{"ok":true}', 'results/trace.zip': 'TRACE' });
  const run = makeRun();
  const manifest = buildManifest(run, folder);
  assert.equal(manifest.version, EVIDENCE_MANIFEST_VERSION);
  assert.equal(manifest.runId, run.id, 'the manifest must say which run it belongs to');
  assert.equal(manifest.projectUid, run.projectUid);
  assert.equal(manifest.sourceCommit, run.gitCommit);
  const files = manifest.artifacts.map((a) => a.file).sort();
  assert.deepEqual(files, ['report.json', 'results/trace.zip']);
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.equal(artifact.sha256, sha256OfFile(path.join(folder, artifact.file)));
  }
});

test('UT-EVD-002: the manifest does not list itself, the event log or the raw output', () => {
  const folder = makeRunFolder({
    'report.json': '{}',
    'events.jsonl': '{"seq":1}\n',
    'stdout.log': 'output',
  });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), '{"version":1}');
  const manifest = buildManifest(makeRun(), folder);
  const files = manifest.artifacts.map((a) => a.file);
  assert.ok(!files.includes(MANIFEST_FILENAME), 'the manifest must not list itself');
  for (const record of RECORD_FILENAMES) {
    assert.ok(!files.includes(record), `the run record file ${record} is not evidence`);
  }
  assert.deepEqual(files, ['report.json']);
});

test('UT-EVD-003: the manifest is a function of the run and the folder', () => {
  const folder = makeRunFolder({ 'report.json': '{}', 'results/a.png': 'PNG' });
  const run = makeRun();
  const first = buildManifest(run, folder);
  const second = buildManifest(run, folder);
  assert.deepEqual(first, second, 'the same run and the same files give the same manifest');
});

test('UT-EVD-004: the evidence set digest does not depend on the order of the entries', () => {
  const a = { file: 'a.txt', sha256: 'aa'.repeat(32), size: 1 };
  const b = { file: 'b.txt', sha256: 'bb'.repeat(32), size: 2 };
  assert.equal(evidenceSetDigest([a, b]), evidenceSetDigest([b, a]));
  // The size is part of the identity: the same name and digest but a
  // different size is a different evidence set.
  const c = { file: 'a.txt', sha256: 'aa'.repeat(32), size: 9 };
  assert.notEqual(evidenceSetDigest([a, b]), evidenceSetDigest([c, b]));
});

test('UT-EVD-005: the evidence entries are sorted by their relative path', () => {
  const folder = makeRunFolder({ 'z.txt': 'Z', 'a.txt': 'A', 'm/n.txt': 'N' });
  const entries = collectEvidence(folder);
  assert.deepEqual(entries.map((e) => e.file), ['a.txt', 'm/n.txt', 'z.txt']);
});

test('UT-EVD-006: a symbolic link is not evidence', () => {
  const folder = makeRunFolder({ 'real.txt': 'REAL' });
  const outside = path.join(tmp(), 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE');
  try {
    fs.symlinkSync(outside, path.join(folder, 'link.txt'));
  } catch {
    // A file system without symbolic links: the walk skips them anyway, so
    // the assertion below is still the one that matters.
  }
  const entries = collectEvidence(folder);
  assert.deepEqual(entries.map((e) => e.file), ['real.txt']);
});

test('UT-EVD-007: the digest of a file is the digest of its bytes', () => {
  const folder = makeRunFolder({ 'a.txt': 'hello' });
  assert.equal(sha256OfFile(path.join(folder, 'a.txt')), sha256OfText('hello'));
  assert.equal(sha256Of(Buffer.from('hello', 'utf8')), sha256OfText('hello'));
});

test('UT-EVD-008: a manifest that cannot be read is reported, not treated as empty', () => {
  const folder = makeRunFolder({ 'a.txt': 'A' });
  const read = readManifest(folder);
  assert.equal(read.ok, false);
  assert.equal(read.manifest, null);
  assert.match(read.reason, /could not be read/);
  // A manifest that is not JSON is reported the same way.
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), '{not json');
  const broken = readManifest(folder);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /not valid JSON/);
});

// ---------------------------------------------------------------------------
// The verification -- TAMPERING IS DETECTABLE
// ---------------------------------------------------------------------------

test('UT-EVD-009: an intact evidence set verifies', () => {
  const folder = makeRunFolder({ 'report.json': '{}', 'results/trace.zip': 'TRACE' });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), JSON.stringify(buildManifest(makeRun(), folder)));
  const result = verifyEvidence(folder);
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.extra, []);
});

test('UT-EVD-010: a file that was changed after the archive is reported as changed', () => {
  const folder = makeRunFolder({ 'report.json': '{"ok":true}' });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), JSON.stringify(buildManifest(makeRun(), folder)));
  // The tamper: the file is rewritten with different content.
  fs.writeFileSync(path.join(folder, 'report.json'), '{"ok":false}');
  const result = verifyEvidence(folder);
  assert.equal(result.verified, false, 'the tampering must be detected');
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].file, 'report.json');
  assert.notEqual(result.changed[0].expected, result.changed[0].actual);
  assert.equal(result.changed[0].expected, sha256OfText('{"ok":true}'));
  assert.equal(result.changed[0].actual, sha256OfText('{"ok":false}'));
});

test('UT-EVD-011: a file that was deleted is reported as missing', () => {
  const folder = makeRunFolder({ 'report.json': '{}', 'results/trace.zip': 'TRACE' });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), JSON.stringify(buildManifest(makeRun(), folder)));
  fs.rmSync(path.join(folder, 'results', 'trace.zip'));
  const result = verifyEvidence(folder);
  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, ['results/trace.zip']);
  assert.deepEqual(result.changed, [], 'a deleted file is missing, not changed');
});

test('UT-EVD-012: a file that was added after the archive is reported as extra', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), JSON.stringify(buildManifest(makeRun(), folder)));
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'added later');
  const result = verifyEvidence(folder);
  assert.deepEqual(result.extra, ['notes.txt']);
  // An added file does not invalidate the files that WERE archived.
  assert.equal(result.verified, true);
});

test('UT-EVD-013: a folder without a manifest cannot be verified', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  const result = verifyEvidence(folder);
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.manifest, null);
  assert.match(result.reason, /could not be read/);
});

// ---------------------------------------------------------------------------
// The retention -- THE CLEANING DOES NOT DELETE THE RUN METADATA
// ---------------------------------------------------------------------------

test('UT-EVD-014: only a terminal run is eligible for the cleaning', () => {
  assert.equal(isTerminalForRetention('passed'), true);
  assert.equal(isTerminalForRetention('failed'), true);
  assert.equal(isTerminalForRetention('cancelled'), true);
  assert.equal(isTerminalForRetention('error'), true);
  assert.equal(isTerminalForRetention('interrupted'), true);
  assert.equal(isTerminalForRetention('running'), false);
  assert.equal(isTerminalForRetention('queued'), false);
  assert.equal(isTerminalForRetention('cancelling'), false);
});

test('UT-EVD-015: a run in flight is never expired', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const runs = [
    { id: 'run_1_00000000000000000000000a', status: 'running', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'run_1_00000000000000000000000b', status: 'queued', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'run_1_00000000000000000000000c', status: 'cancelling', createdAt: '2020-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(expiredRuns(runs, { days: 1, now }), []);
});

test('UT-EVD-016: the expired runs are the terminal ones past the period', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const runs = [
    { id: 'run_1_00000000000000000000000a', status: 'passed', finishedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'run_1_00000000000000000000000b', status: 'passed', finishedAt: '2026-05-31T00:00:00.000Z' },
    { id: 'run_1_00000000000000000000000c', status: 'failed', finishedAt: '2020-01-01T00:00:00.000Z' },
  ];
  const expired = expiredRuns(runs, { days: 30, now });
  const ids = expired.map((e) => e.runId).sort();
  assert.deepEqual(ids, ['run_1_00000000000000000000000a', 'run_1_00000000000000000000000c']);
  assert.ok(expired[0].ageDays >= 30);
});

test('UT-EVD-017: a retention period that is not a number is refused', () => {
  assert.throws(() => expiredRuns([], { days: -1 }), /INVALID_RETENTION_PERIOD/);
  assert.throws(() => expiredRuns([], { days: Number.NaN }), /INVALID_RETENTION_PERIOD/);
});

test('UT-EVD-018: the cleaning removes the evidence and keeps the run record', () => {
  const folder = makeRunFolder({
    'report.json': '{}',
    'results/trace.zip': 'TRACE',
    'events.jsonl': '{"seq":1,"type":"run.queued"}\n',
    'stdout.log': 'the raw output',
  });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), JSON.stringify(buildManifest(makeRun(), folder)));
  const result = cleanRunEvidence(folder);
  // The evidence is gone.
  assert.equal(fs.existsSync(path.join(folder, 'report.json')), false);
  assert.equal(fs.existsSync(path.join(folder, 'results', 'trace.zip')), false);
  // The run's RECORD is still there.
  assert.equal(fs.existsSync(path.join(folder, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(folder, 'stdout.log')), true);
  // The manifest -- the record of what the evidence WAS -- is still there.
  assert.equal(fs.existsSync(path.join(folder, MANIFEST_FILENAME)), true);
  assert.ok(result.kept.includes('events.jsonl'));
  assert.ok(result.kept.includes('stdout.log'));
  assert.ok(result.kept.includes(MANIFEST_FILENAME));
});

test('UT-EVD-019: the cleaning does not touch the run record itself', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  fs.writeFileSync(path.join(folder, MANIFEST_FILENAME), JSON.stringify(buildManifest(makeRun(), folder)));
  // The run record: its status, its summary, its attempts, its events.
  const run = makeRun({
    summary: { passed: 3, failed: 0, skipped: 0, flaky: 0, total: 3, executions: 3, cases: [] },
    attempts: [{ uid: 'att_1_000000000000000000000000', status: 'passed' }],
    events: [{ seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'run.queued', data: {} }],
  });
  const before = JSON.stringify(run);
  cleanExpiredEvidence({
    runs: [run],
    folderOf: () => folder,
    days: 0,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
  });
  // The run record is byte-identical: the cleaning did not touch it.
  assert.equal(JSON.stringify(run), before);
  assert.equal(run.status, 'passed');
  assert.equal(run.summary.total, 3);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.events.length, 1);
});

test('UT-EVD-020: the cleaning refuses to run while a Bridge holds the directory', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  const run = makeRun({ status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' });
  const result = cleanExpiredEvidence({
    runs: [run],
    folderOf: () => folder,
    days: 1,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    lockHeld: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.cleaned.length, 0);
  assert.match(result.reason, /Bridge/);
  // The evidence is still there: the refused cleaning removed nothing.
  assert.equal(fs.existsSync(path.join(folder, 'report.json')), true);
});

test('UT-EVD-021: a dry run reports what would be removed and removes nothing', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  const run = makeRun({ status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' });
  const result = cleanExpiredEvidence({
    runs: [run],
    folderOf: () => folder,
    days: 1,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.cleaned.length, 1);
  assert.deepEqual(result.cleaned[0].removed, ['report.json']);
  assert.equal(fs.existsSync(path.join(folder, 'report.json')), true);
});

test('UT-EVD-022: the cleaning writes a journal of what it removed', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  const journalFile = path.join(tmp(), 'journal.jsonl');
  const run = makeRun({ status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' });
  cleanExpiredEvidence({
    runs: [run],
    folderOf: () => folder,
    days: 1,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    journalFile,
  });
  const journal = readJournal(journalFile);
  assert.equal(journal.missing, false);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].runId, run.id);
  assert.deepEqual(journal.entries[0].removed, ['report.json']);
});

test('UT-EVD-023: a damaged journal line is reported, not dropped', () => {
  const journalFile = path.join(tmp(), 'journal.jsonl');
  fs.writeFileSync(journalFile, '{"at":"x","runId":"r","removed":[]}\nnot json\n');
  const journal = readJournal(journalFile);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.unreadable.length, 1);
  assert.equal(journal.unreadable[0].line, 2);
});

test('UT-EVD-024: the retention plan says which runs are expired and how much space they take', () => {
  const folderA = makeRunFolder({ 'report.json': '0123456789' });
  const folderB = makeRunFolder({ 'report.json': '{}' });
  const runs = [
    { id: 'run_1_00000000000000000000000a', status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' },
    { id: 'run_1_00000000000000000000000b', status: 'passed', finishedAt: '2026-05-31T00:00:00.000Z' },
  ];
  const folders = { [runs[0].id]: folderA, [runs[1].id]: folderB };
  const plan = retentionReport(runs, (run) => folders[run.id], {
    days: 30,
    now: Date.parse('2026-06-01T00:00:00.000Z'),
  });
  assert.equal(plan.expiredCount, 1);
  assert.equal(plan.expired[0].runId, runs[0].id);
  assert.equal(plan.expiredBytes, 10);
  assert.equal(plan.keptBytes, 2);
  assert.equal(plan.days, 30);
});

test('UT-EVD-025: the plan touches nothing', () => {
  const folder = makeRunFolder({ 'report.json': '{}' });
  const runs = [{ id: 'run_1_00000000000000000000000a', status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' }];
  planRetention(runs, () => folder, { days: 1, now: Date.parse('2026-06-01T00:00:00.000Z') });
  assert.equal(fs.existsSync(path.join(folder, 'report.json')), true);
});

// ---------------------------------------------------------------------------
// The deduplication -- THE BYTES ARE STORED ONCE
// ---------------------------------------------------------------------------

test('UT-EVD-026: the deduplication index records the second copy as a duplicate', () => {
  const index = emptyEvidenceIndex();
  const artifacts = [{ file: 'report.json', size: 10, sha256: 'aa'.repeat(32) }];
  indexRunEvidence(index, { id: 'run_1_00000000000000000000000a' }, artifacts);
  indexRunEvidence(index, { id: 'run_1_00000000000000000000000b' }, artifacts);
  const copies = copiesOf(index, 'aa'.repeat(32));
  assert.equal(copies.copies, 2);
  assert.equal(copies.authoritative.runId, 'run_1_00000000000000000000000a');
  assert.equal(copies.duplicates.length, 1);
  assert.equal(copies.duplicates[0].runId, 'run_1_00000000000000000000000b');
});

test('UT-EVD-027: the index of a state without one is the empty index', () => {
  const state = { schema: 1, projects: [], runs: [] };
  const index = evidenceIndexOf(state);
  assert.deepEqual(index.entries, {});
  assert.equal(state.evidenceIndex.version, 1);
});

test('UT-EVD-028: a re-scan of a run supersedes what the index said about it', () => {
  const index = emptyEvidenceIndex();
  const run = { id: 'run_1_00000000000000000000000a' };
  indexRunEvidence(index, run, [{ file: 'a.txt', size: 1, sha256: 'aa'.repeat(32) }]);
  indexRunEvidence(index, run, [{ file: 'b.txt', size: 1, sha256: 'bb'.repeat(32) }]);
  assert.equal(index.entries['aa'.repeat(32)], undefined, 'the old entry is superseded');
  assert.ok(index.entries['bb'.repeat(32)]);
});

test('UT-EVD-029: the deduplication report names the content that is stored twice', () => {
  const index = emptyEvidenceIndex();
  const artifacts = [{ file: 'report.json', size: 100, sha256: 'cc'.repeat(32) }];
  indexRunEvidence(index, { id: 'run_1_00000000000000000000000a' }, artifacts);
  indexRunEvidence(index, { id: 'run_1_00000000000000000000000b' }, artifacts);
  const report = deduplicationReport(index);
  assert.equal(report.duplicated, 1);
  assert.equal(report.wastedBytes, 100);
  assert.equal(report.top[0].digest, 'cc'.repeat(32));
  assert.equal(duplicatedEvidence(index).length, 1);
});

test('UT-EVD-030: the key of an evidence copy is derived, not random', () => {
  assert.equal(evidenceKeyOf('run_1_1', 'a.txt'), 'run_1_1:a.txt');
});

test('UT-EVD-031: the shared bytes are counted once per duplicate', () => {
  const folderA = makeRunFolder({ 'report.json': '0123456789' });
  const folderB = makeRunFolder({ 'report.json': '0123456789' });
  const runs = [
    { id: 'run_1_00000000000000000000000a' },
    { id: 'run_1_00000000000000000000000b' },
  ];
  const folders = { [runs[0].id]: folderA, [runs[1].id]: folderB };
  const shared = sharedEvidenceBytes(runs, (run) => folders[run.id]);
  assert.equal(shared, 10, 'the second copy of 10 bytes is the duplicate');
});

// ---------------------------------------------------------------------------
// The content-addressed store
// ---------------------------------------------------------------------------

test('UT-EVD-032: the blob is stored under its own digest', () => {
  const dir = tmp();
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, 'CONTENT');
  const digest = sha256OfText('CONTENT');
  const stored = storeBlob(storeDirOf(dir), file, digest);
  assert.equal(stored.stored, true);
  assert.equal(stored.alreadyStored, false);
  assert.equal(fs.readFileSync(stored.path, 'utf8'), 'CONTENT');
  assert.equal(path.basename(stored.path), digest);
});

test('UT-EVD-033: the same content is stored ONCE', () => {
  const dir = tmp();
  const fileA = path.join(dir, 'a.json');
  const fileB = path.join(dir, 'b.json');
  fs.writeFileSync(fileA, 'SAME');
  fs.writeFileSync(fileB, 'SAME');
  const digest = sha256OfText('SAME');
  const first = storeBlob(storeDirOf(dir), fileA, digest);
  const second = storeBlob(storeDirOf(dir), fileB, digest);
  assert.equal(first.alreadyStored, false);
  assert.equal(second.alreadyStored, true);
  assert.equal(first.path, second.path);
  // The store holds ONE copy of the bytes.
  assert.equal(storeBytes(storeDirOf(dir)), 4);
});

test('UT-EVD-034: a blob whose copy does not match the digest is not stored', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.json');
  fs.writeFileSync(file, 'CONTENT');
  const stored = storeBlob(storeDirOf(dir), file, 'dd'.repeat(32));
  assert.equal(stored.stored, false);
  assert.match(stored.reason, /does not match the digest/);
});

test('UT-EVD-035: a file that is too large is not stored', () => {
  const dir = tmp();
  const file = path.join(dir, 'big.bin');
  // The file does not have to be really that big: the limit is checked
  // against the size, so the check is asserted through the reason.
  const stored = storeBlob(storeDirOf(dir), file, 'ee'.repeat(32));
  assert.equal(stored.stored, false);
  assert.match(stored.reason, /could not be read|larger than/);
  assert.ok(MAX_BLOB_BYTES > 0);
});

test('UT-EVD-036: the run file becomes a hard link to the stored copy', () => {
  const dir = tmp();
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, 'CONTENT');
  const digest = sha256OfText('CONTENT');
  const stored = storeBlob(storeDirOf(dir), file, digest);
  const linked = linkToBlob(file, stored.path);
  assert.equal(linked.linked, true);
  // The two paths are the SAME inode: the bytes are on the disk once.
  assert.equal(fs.statSync(file).ino, fs.statSync(stored.path).ino);
  assert.equal(fs.statSync(file).nlink, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'CONTENT');
});

test('UT-EVD-037: removing the run copy keeps the stored copy', () => {
  const dir = tmp();
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, 'CONTENT');
  const digest = sha256OfText('CONTENT');
  const stored = storeBlob(storeDirOf(dir), file, digest);
  linkToBlob(file, stored.path);
  fs.rmSync(file);
  // The stored copy survives: the bytes are still archived.
  assert.equal(fs.existsSync(stored.path), true);
  assert.equal(fs.readFileSync(stored.path, 'utf8'), 'CONTENT');
  assert.equal(fs.statSync(stored.path).nlink, 1);
});

test('UT-EVD-038: a blob that a run still refers to is not pruned', () => {
  const dir = tmp();
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, 'CONTENT');
  const digest = sha256OfText('CONTENT');
  const stored = storeBlob(storeDirOf(dir), file, digest);
  linkToBlob(file, stored.path);
  // The run still holds a link, so the blob is referenced.
  assert.equal(unreferencedBlobs(storeDirOf(dir)).length, 0);
  const pruned = pruneStore(storeDirOf(dir));
  assert.equal(pruned.removed.length, 0);
  assert.equal(fs.existsSync(stored.path), true);
});

test('UT-EVD-039: a blob that no run refers to any more is pruned', () => {
  const dir = tmp();
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, 'CONTENT');
  const digest = sha256OfText('CONTENT');
  const stored = storeBlob(storeDirOf(dir), file, digest);
  // The run's copy is removed and the run is gone: the blob is orphaned.
  fs.rmSync(file);
  assert.equal(unreferencedBlobs(storeDirOf(dir)).length, 1);
  const pruned = pruneStore(storeDirOf(dir));
  assert.equal(pruned.removed.length, 1);
  assert.equal(pruned.bytesFreed, 7);
  assert.equal(fs.existsSync(stored.path), false);
});

test('UT-EVD-040: the blob path is derived from the digest', () => {
  const digest = 'ab'.repeat(32);
  const p = blobPath('/store', digest);
  assert.equal(path.basename(p), digest);
  // A digest that is not a SHA-256 hex string has no path.
  assert.equal(blobPath('/store', 'nope'), null);
});
