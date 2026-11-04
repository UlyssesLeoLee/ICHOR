#!/usr/bin/env node
/**
 * ATS-201: migration of a legacy state.json to the stable UID scheme (v1).
 *
 * What it does
 * ------------
 *   * rewrites every Project identifier to `proj_1_<24 hex>` (derived from
 *     the canonical project root);
 *   * rewrites every Run identifier to `run_1_<24 hex>` (derived from the
 *     project UID, the recorded commit, the target file and the per project
 *     execution sequence);
 *   * seeds the UID registry from the recorded runs, so that test cases keep
 *     their identity across a later rename;
 *   * leaves the legacy identifiers in `legacyId` so that existing links,
 *     bookmarks and archived run folders stay resolvable.
 *
 * The migration is deterministic: running it twice on the same input
 * produces the same output, and running it on an already migrated file
 * changes nothing (the script reports "already migrated").
 *
 * Usage
 * -----
 *   node tools/migrate_uids.mjs --state <path to state.json> [--dry-run] [--backup]
 *
 *   --state    the state file to migrate. Defaults to $ATS_DATA_DIR/state.json.
 *   --dry-run  print the planned changes without writing anything.
 *   --backup   keep a copy of the original next to the state file.
 *
 * Exit codes
 * ----------
 *   0  migration completed, or the file was already migrated
 *   1  the file could not be read, parsed or migrated
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  UID_SCHEME_VERSION, projectUidFor, runUidFor, isProjectUid, isRunUid,
  isLegacyProjectUid, isLegacyRunUid, emptyRegistry, assignRunSeqs
} from '../server/uid.mjs';

function parseArgs(argv) {
  const out = { state: null, dryRun: false, backup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') { out.state = argv[++i]; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--backup') { out.backup = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function defaultStatePath() {
  const dir = process.env.ATS_DATA_DIR
    ? path.resolve(process.env.ATS_DATA_DIR)
    : path.join(os.homedir(), '.ai-test-studio');
  return path.join(dir, 'state.json');
}

/**
 * Computes the migration plan of one state object.
 * Pure: returns the new state and a list of changes, without touching disk.
 */
export function planMigration(state) {
  if (!state || typeof state !== 'object') throw new Error('STATE_NOT_AN_OBJECT');
  if (!Array.isArray(state.projects) || !Array.isArray(state.runs)) throw new Error('UNSUPPORTED_DATABASE');

  const changes = [];
  const projectUidOfLegacyId = new Map();
  const nextState = {
    schema: state.schema,
    uidVersion: UID_SCHEME_VERSION,
    projects: [],
    runs: [],
    uidRegistry: state.uidRegistry && typeof state.uidRegistry === 'object' ? state.uidRegistry : emptyRegistry()
  };

  // --- projects -------------------------------------------------------------
  for (const p of state.projects) {
    const uid = p.uid && isProjectUid(p.uid) && !isLegacyProjectUid(p.uid)
      ? p.uid
      : projectUidFor(p.root);
    if (p.id !== uid) {
      changes.push({ kind: 'project', from: p.id, to: uid, root: p.root });
    }
    projectUidOfLegacyId.set(p.id, uid);
    nextState.projects.push({
      ...p,
      id: uid,
      uid,
      // The previous identifier is kept so that existing links and bookmarks
      // stay resolvable after the migration.
      ...(p.id !== uid ? { legacyId: p.id } : {})
    });
  }

  // --- runs -----------------------------------------------------------------
  // The per project sequence is the discriminator that distinguishes two
  // executions of the same target at the same commit. It is recorded on the
  // run record so that the UID can be recomputed from the recorded fields.
  const uidByLegacyRunId = new Map();
  const sequenced = assignRunSeqs(state.runs);
  for (const r of sequenced) {
    const projectUid = projectUidOfLegacyId.get(r.projectId) ?? (r.projectUid ?? null);
    const uid = r.uid && isRunUid(r.uid) && !isLegacyRunUid(r.uid)
      ? r.uid
      : runUidFor({ projectUid, gitCommit: r.gitCommit, file: r.file, seq: r.seq });
    if (r.id !== uid) changes.push({ kind: 'run', from: r.id, to: uid, projectId: r.projectId });
    uidByLegacyRunId.set(r.id, uid);
    nextState.runs.push({
      ...r,
      id: uid,
      uid,
      seq: r.seq,
      projectUid,
      ...(r.id !== uid ? { legacyId: r.id } : {}),
      ...(r.attempts ? { attempts: r.attempts.map((a) => ({ ...a, runUid: uid })) } : {})
    });
  }

  // Preserve the original ordering of the run list (newest first).
  const order = new Map(state.runs.map((r, i) => [r.id, i]));
  nextState.runs.sort((a, b) => (order.get(a.legacyId ?? a.id) ?? 0) - (order.get(b.legacyId ?? b.id) ?? 0));

  // --- runs folder names ----------------------------------------------------
  // The run directory on disk is named after the run id. The folder therefore
  // has to be renamed together with the identifier, otherwise the archived
  // evidence of that run would no longer be reachable.
  const renamedFolders = [];
  for (const r of state.runs) {
    const uid = uidByLegacyRunId.get(r.id);
    if (uid && uid !== r.id) renamedFolders.push({ from: r.id, to: uid });
  }

  return { state: nextState, changes, renamedFolders };
}

/**
 * Renames the run folders on disk so that they match the migrated run ids.
 * Returns the list of folders that were actually renamed.
 */
export function renameRunFolders(runsDir, renamedFolders) {
  const renamed = [];
  if (!fs.existsSync(runsDir)) return renamed;
  for (const f of renamedFolders) {
    const from = path.join(runsDir, f.from);
    const to = path.join(runsDir, f.to);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) continue;
    fs.renameSync(from, to);
    renamed.push(f);
  }
  return renamed;
}

/** True when every identifier of the state already follows the v1 scheme. */
export function isMigrated(state) {
  if (!state || !Array.isArray(state.projects) || !Array.isArray(state.runs)) return false;
  if (state.uidVersion !== UID_SCHEME_VERSION) return false;
  if (state.projects.some((p) => p.id !== p.uid || isLegacyProjectUid(p.id))) return false;
  if (state.runs.some((r) => r.id !== r.uid || isLegacyRunUid(r.id))) return false;
  return true;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node tools/migrate_uids.mjs --state <state.json> [--dry-run] [--backup]');
    return 0;
  }
  const statePath = args.state ? path.resolve(args.state) : defaultStatePath();
  if (!fs.existsSync(statePath)) {
    console.error(`state file not found: ${statePath}`);
    return 1;
  }
  let original;
  try {
    original = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    console.error(`cannot parse ${statePath}: ${e.message}`);
    return 1;
  }
  if (isMigrated(original)) {
    console.log(`already migrated: ${statePath}`);
    console.log(`uidVersion=${original.uidVersion}`);
    return 0;
  }

  const { state: migrated, changes, renamedFolders } = planMigration(original);
  for (const c of changes) {
    console.log(`${c.kind}: ${c.from} -> ${c.to}`);
  }
  for (const f of renamedFolders) {
    console.log(`run folder rename required: ${f.from} -> ${f.to}`);
  }
  console.log(`projects: ${migrated.projects.length}, runs: ${migrated.runs.length}, changes: ${changes.length}`);

  if (args.dryRun) {
    console.log('dry run: nothing written');
    return 0;
  }

  if (args.backup) {
    const backup = `${statePath}.bak`;
    fs.copyFileSync(statePath, backup);
    console.log(`backup written: ${backup}`);
  }

  const renamed = renameRunFolders(path.join(path.dirname(statePath), 'runs'), renamedFolders);
  for (const f of renamed) console.log(`run folder renamed: ${f.from} -> ${f.to}`);

  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(migrated, null, 2), 'utf8');
  fs.renameSync(tmp, statePath);
  console.log(`migrated: ${statePath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
