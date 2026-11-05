#!/usr/bin/env node
/**
 * ATS-512 probe -- the plugin permission boundary.
 *
 * The probe plays the role of the **host**: it constructs the SDK with a
 * controlled policy tier and a controlled scope, hands it to the sample
 * plugin, and checks that the plugin cannot exceed what the host granted.
 *
 * The three facts this probe proves:
 *
 *   1. **超权被拒**: a plugin that calls an operation whose permission the
 *      host did not grant is refused with PLUGIN_PERMISSION_DENIED, and the
 *      refusal is audited.
 *   2. **插件不绕过审核**: an outcome is a proposal with approval=pending and
 *      producedBy=plugin:<id>; the plugin may not review its own proposal.
 *   3. **插件不绕过证据**: the SHA-256 of an evidence reference is computed by
 *      the host resolver; a plugin-supplied digest is not part of the input at
 *      all, and an outcome without an evidence reference is refused.
 *
 * NEGATIVE CONTROL (signal 4): the same detector must FIRE on a plugin that
 * is handed an over-privileged tier. Without it, "the plugin is refused"
 * could be a vacuously true statement. The control grants the plugin the
 * `reporter` tier and shows that the very same call then succeeds -- so the
 * refusal in signal 1 is caused by the permission list, not by a broken SDK.
 *
 * Usage: node tools/ats512-probes/probe-plugin-boundary.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPluginSdk, reviewPluginProposal } from '../../server/plugins/sdk.mjs';
import {
  PLUGIN_FORBIDDEN_PERMISSIONS,
  PLUGIN_OPERATIONS,
  PLUGIN_PERMISSIONS,
  PLUGIN_POLICY_TIERS,
  PLUGIN_SDK_SURFACE,
  resolvePluginPermissions,
  validatePluginManifest,
} from '../../server/plugins/contract.mjs';

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PROBE_DIR, '..', '..');
const WORK_ROOT = path.resolve(
  process.env.ATS_PROBE_WORKDIR || path.join(process.env.TMPDIR || os.tmpdir(), 'ats512-probes'),
);

const RUN_UID = 'run_00000000-0000-4000-8000-000000000001';

const failures = [];
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

console.log('=== ATS-512 probe: the plugin permission boundary ===');
console.log(`repo root : ${REPO_ROOT}`);
console.log(`work root : ${WORK_ROOT}`);
console.log('');

/** A host whose audit sink records everything, and whose reader is honest. */
function makeHost(overrides = {}) {
  const events = [];
  return {
    events,
    host: {
      audit: (event) => { events.push(event); },
      readTestFile: async (projectId, file) => ({
        projectId,
        file,
        content: `// ${file}\n`,
        hash: 'f'.repeat(64),
      }),
      readRequirements: async (projectId) => ({ projectId, requirements: [] }),
      readRunEvidence: async (projectId, runUid) => ({ projectId, runUid, artifacts: [] }),
      resolveEvidenceDigest: async (projectId, runUid, ref) => 'd'.repeat(64),
      ...overrides,
    },
  };
}

/** The sample plugin's manifest, as it is on disk. */
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'examples', 'sample-plugin', 'manifest.json'), 'utf8'),
);
// A dynamic import needs a file:// URL on Windows: a bare absolute path
// ("C:/...") is rejected by the ESM loader as an unsupported scheme.
const samplePlugin = (await import(
  pathToFileURL(path.join(REPO_ROOT, 'examples', 'sample-plugin', 'index.mjs')).href
)).default;

/* ------------------------------------------------------------------ */
/* 0. the sample plugin itself                                         */
/* ------------------------------------------------------------------ */

console.log('--- signal 0: the sample plugin is a valid protocol sample ---');
let validated = null;
try {
  validated = validatePluginManifest(manifest);
  check('the sample manifest satisfies the plugin contract', true);
} catch (error) {
  check('the sample manifest satisfies the plugin contract', false, error.code || error.message);
}
if (validated) {
  check('the sample declares only permissions from the vocabulary',
    validated.permissions.every((p) => Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, p)),
    validated.permissions.join(','));
  check('the sample declares no forbidden permission',
    validated.permissions.every((p) => !PLUGIN_FORBIDDEN_PERMISSIONS.includes(p)));
}
check('the sample plugin exports a run() function', typeof samplePlugin?.run === 'function');

/* ------------------------------------------------------------------ */
/* 1. an operation above the tier is refused                           */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 1: a plugin that exceeds its permission is refused ---');
{
  const { host, events } = makeHost();
  // The plugin declares `outcome.report`, the host grants `readonly`.
  const sdk = createPluginSdk({
    manifest: { ...manifest, permissions: ['test.read', 'outcome.report'] },
    host,
    tier: 'readonly',
    scope: { files: ['tests'] },
  });
  let code = null;
  try {
    await sdk.reportOutcome('proj_probe', RUN_UID, { summary: 'x', evidenceRefs: ['trace.zip'] });
  } catch (error) {
    code = error.code;
  }
  check('the over-privileged call is refused', code === 'PLUGIN_PERMISSION_DENIED', `code=${code}`);
  const denied = events.filter((e) => e.type === 'plugin.operation.denied');
  check('the refusal is audited', denied.length === 1, `events=${events.length}`);
  check('the audit event names the missing permission',
    denied.length === 1 && denied[0].data.permission === 'outcome.report');
}

/* ------------------------------------------------------------------ */
/* 2. the plugin cannot review its own proposal                        */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 2: a plugin cannot approve its own outcome ---');
{
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: { ...manifest, permissions: ['test.read', 'outcome.report'] },
    host,
    tier: 'reporter',
    scope: { files: ['tests'] },
  });
  const proposal = await sdk.reportOutcome('proj_probe', RUN_UID, {
    summary: 'the sample run passed',
    status: 'passed',
    evidenceRefs: ['trace.zip'],
  });
  check('the outcome is a proposal, not a state change', proposal.approval === 'pending');
  check('the proposal names the plugin as its producer',
    proposal.producedBy === `plugin:${manifest.id}`, proposal.producedBy);
  let code = null;
  try {
    reviewPluginProposal(proposal, { reviewer: `plugin:${manifest.id}`, decision: 'approved' });
  } catch (error) {
    code = error.code;
  }
  check('the plugin cannot review its own proposal', code === 'PLUGIN_REVIEW_SELF_FORBIDDEN', `code=${code}`);
  const approved = reviewPluginProposal(proposal, { reviewer: 'probe-reviewer', decision: 'approved' });
  check('an independent reviewer can approve', approved.approval === 'approved');
}

/* ------------------------------------------------------------------ */
/* 3. the plugin cannot forge the evidence                             */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 3: the evidence digest comes from the host ---');
{
  let hostCalls = 0;
  const { host } = makeHost({
    resolveEvidenceDigest: async (projectId, runUid, ref) => {
      hostCalls += 1;
      return 'e'.repeat(64);
    },
  });
  const sdk = createPluginSdk({
    manifest: { ...manifest, permissions: ['test.read', 'outcome.report'] },
    host,
    tier: 'reporter',
    scope: { files: ['tests'] },
  });
  const proposal = await sdk.reportOutcome('proj_probe', RUN_UID, {
    summary: 'the sample run passed',
    evidenceRefs: ['trace.zip'],
  });
  check('the host resolver was consulted', hostCalls === 1, `calls=${hostCalls}`);
  check('the digest in the proposal is the host\'s',
    proposal.evidenceRefs[0].sha256 === 'e'.repeat(64));

  // A plugin that tries to hand the SDK its own digest gets the entry
  // rejected: the SDK only accepts a reference, never a {ref, sha256} pair.
  let code = null;
  try {
    await sdk.reportOutcome('proj_probe', RUN_UID, {
      summary: 'trust me',
      evidenceRefs: [{ ref: 'trace.zip', sha256: 'c'.repeat(64) }],
    });
  } catch (error) {
    code = error.code;
  }
  check('a plugin-supplied digest is refused', code === 'PLUGIN_PROPOSAL_INVALID', `code=${code}`);

  // An outcome with no evidence at all is refused too.
  code = null;
  try {
    await sdk.reportOutcome('proj_probe', RUN_UID, { summary: 'no evidence' });
  } catch (error) {
    code = error.code;
  }
  check('an outcome without evidence is refused', code === 'PLUGIN_EVIDENCE_REQUIRED', `code=${code}`);
}

/* ------------------------------------------------------------------ */
/* 3b. the plugin cannot read outside the granted scope                 */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 3b: a plugin cannot read outside the granted scope ---');
{
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest,
    host,
    tier: 'readonly',
    scope: { files: ['tests'] },
  });
  let code = null;
  try {
    await sdk.readTestFile('proj_probe', 'server/index.mjs');
  } catch (error) {
    code = error.code;
  }
  check('a file outside the scope is refused', code === 'PLUGIN_SCOPE_INVALID', `code=${code}`);
  check('the scope refusal is audited',
    events.some((e) => e.type === 'plugin.scope.denied'));
}

/* ------------------------------------------------------------------ */
/* 4. NEGATIVE CONTROL: the same call succeeds under a higher tier    */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 4: negative control -- the refusal is caused by the permission list ---');
{
  // The SAME plugin, the SAME call, the SAME SDK -- only the tier differs.
  // If the tier did not matter, the refusal in signal 1 would prove nothing.
  const { host } = makeHost();
  const sdk = createPluginSdk({
    manifest: { ...manifest, permissions: ['test.read', 'outcome.report'] },
    host,
    tier: 'reporter',
    scope: { files: ['tests'] },
  });
  let refused = false;
  try {
    await sdk.reportOutcome('proj_probe', RUN_UID, { summary: 'x', evidenceRefs: ['trace.zip'] });
  } catch (error) {
    refused = error.code === 'PLUGIN_PERMISSION_DENIED';
  }
  check('the very same call is ALLOWED under the reporter tier', refused === false);

  // And the permission resolution itself differs by tier.
  const readOnly = resolvePluginPermissions(['test.read', 'outcome.report'], 'readonly');
  const reporter = resolvePluginPermissions(['test.read', 'outcome.report'], 'reporter');
  check('readonly grants fewer permissions than reporter',
    readOnly.granted.length < reporter.granted.length,
    `readonly=${readOnly.granted.join(',')} reporter=${reporter.granted.join(',')}`);
}

/* ------------------------------------------------------------------ */
/* 5. the sample plugin runs within its permission                     */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 5: the sample plugin runs inside its permission ---');
{
  const { host, events } = makeHost();
  const sdk = createPluginSdk({
    manifest,
    host,
    tier: 'readonly',
    scope: { files: ['tests'] },
  });
  const result = await samplePlugin.run(sdk, {
    projectId: 'proj_probe',
    files: ['tests/login.spec.ts'],
  });
  check('the sample plugin read the file it was given',
    result.files.length === 1 && result.files[0].file === 'tests/login.spec.ts',
    JSON.stringify(result.files));
  check('the sample plugin reports the granted permissions',
    result.grantedPermissions.includes('test.read'));
  check('the read was audited', events.some((e) => e.type === 'plugin.test.read'));
  // The sample plugin asks for nothing it was not granted.
  const denied = events.filter((e) => e.type === 'plugin.operation.denied');
  check('the sample plugin triggered no denial', denied.length === 0,
    denied.map((e) => JSON.stringify(e.data)).join(' | '));
}

/* ------------------------------------------------------------------ */
/* 6. the vocabulary is closed                                         */
/* ------------------------------------------------------------------ */

console.log('');
console.log('--- signal 6: the permission vocabulary is closed ---');
{
  // A permission outside the vocabulary is reported, never granted.
  const resolution = resolvePluginPermissions(['not.a.permission'], 'reporter');
  check('an unknown permission is denied', resolution.granted.length === 0);
  check('the denial says why', resolution.denied[0]?.reason === 'unknown',
    JSON.stringify(resolution.denied));

  // Every tier is a subset of the vocabulary and excludes the forbidden set.
  let tiersOk = true;
  for (const [name, list] of Object.entries(PLUGIN_POLICY_TIERS)) {
    for (const permission of list) {
      if (!Object.prototype.hasOwnProperty.call(PLUGIN_PERMISSIONS, permission)) tiersOk = false;
      if (PLUGIN_FORBIDDEN_PERMISSIONS.includes(permission)) tiersOk = false;
    }
  }
  check('every tier grants only vocabulary permissions', tiersOk);

  // The SDK surface and the operation table agree.
  check('the SDK surface matches the operation table',
    PLUGIN_SDK_SURFACE.length === Object.keys(PLUGIN_OPERATIONS).length
    && PLUGIN_SDK_SURFACE.every((n) => PLUGIN_OPERATIONS[n]));
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('--- verdict ---');
if (failures.length) {
  console.log(`FAIL: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS: a plugin cannot exceed its declared permissions, review its own outcome, or forge evidence');
}
