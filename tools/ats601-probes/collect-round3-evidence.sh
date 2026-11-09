#!/usr/bin/env bash
# ATS-601 -- the evidence of the third rework round.
#
# The second review rejected the delivery with ONE mandatory item (R6): the
# DEVICE layer reported a capability the TARGET never declared as "proved",
# which contradicted the resolve path about ONE session.
#
# The third review checks exactly three things:
#
#   1. the device layer does not report an undeclared capability as proved,
#      and the resolve path and the device layer agree about one session;
#   2. at least one unit test covers R6, and that unit test is RED on the
#      pre-fix tree (3bac3bd);
#   3. the delivered tree carries the review probe's R6/C6 lines green, the
#      full regression, the ATS-301 gate, the remote protocol audit and the
#      checksum manifest.
#
# This script collects the evidence for all three on the tree that is
# actually delivered.
#
# The probe of the review is INPUT: it arrives as an issue attachment
# (ats601-r2-probes.zip) and is NOT a deliverable, so it is not checked in.
# Unpack it into a directory laid out like this:
#
#   <probe-dir>/r2/review-r1.mjs
#
# The fixture dependency trees (examples/sample-playwright/node_modules and
# examples/sample-wdio/node_modules) are NOT part of the repository; install
# them in the measured tree, or the IT cases that need a real engine will
# skip instead of run.
#
# usage: bash tools/ats601-probes/collect-round3-evidence.sh <tree> <probe-dir>
set -uo pipefail

TREE="$1"
PROBES="$2"
PROBES_NATIVE="$(cd "$PROBES" && pwd -W 2>/dev/null || echo "$PROBES")"
cd "$TREE" || exit 1

export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"

hdr() {
  echo
  echo "=============================================================="
  echo "$*"
  echo "=============================================================="
}

hdr "the tree under test"
echo "tree    : $(pwd -W 2>/dev/null || pwd)"
echo "commit  : $(git rev-parse HEAD)"
echo "branch  : $(git branch --show-current)"
echo "node    : $(node --version)"
echo "python  : $(python --version 2>&1)"

# --- R6 item 1: the device layer and the resolve path agree ---------------
hdr "R6.1 -- the device layer does not prove what the target never declared"
node - <<'JS'
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const tree = process.cwd();
const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
const mt = await imp('server/adapters/mobile-target.mjs');
const { createMobileAdapter } = await imp('server/adapters/mobile.mjs');
const { negotiateWithDevice } = await imp('server/adapters/contract.mjs');

const { defineTarget, defineSession, SESSION_STATE, TARGET_KIND, MOBILE_CAPABILITIES } = mt;

const narrow = defineTarget({
  targetId: 'tgt_narrow', kind: TARGET_KIND.LOCAL_EMULATOR, platform: 'android',
  capabilities: ['screen.capture'],
});
const wide = defineSession({
  sessionId: 'ses_wide', targetId: 'tgt_narrow', state: SESSION_STATE.CREATED,
  capabilities: MOBILE_CAPABILITIES,
});
const adapter = createMobileAdapter({ target: narrow, session: wide, registeredSessionIds: ['ses_wide'] });

const entries = adapter.device.capabilities({ session: wide, target: narrow });
const byName = new Map(entries.map((e) => [e.name, e]));
let failed = 0;
const check = (ok, text, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const hierarchy = byName.get('ui.hierarchy');
check(hierarchy.supported === false, 'ui.hierarchy (never declared) is not supported',
  `supported=${hierarchy.supported}`);
check(hierarchy.evidence === '', 'ui.hierarchy carries no "proved" evidence',
  `evidence="${hierarchy.evidence}"`);
check(/not declared by target/.test(hierarchy.reason), 'the reason names the target declaration',
  `reason=${hierarchy.reason}`);
check(byName.get('screen.capture').supported === true,
  'the DECLARED capability is still proved by the same session');

const neg = negotiateWithDevice(adapter, { root: tree },
  { session: wide, target: narrow, requested: ['ui.hierarchy'] }, []);
check(neg.device.supported === false, 'negotiateWithDevice does not report it as proved',
  `device.supported=${neg.device.supported}`);

let refused = null;
try { adapter.resolveDevice(); } catch (e) { refused = e.code; }
check(refused === 'REMOTE_CAPABILITY_MISSING',
  'the resolve path refuses the same session', `code=${refused}`);

console.log('');
console.log(failed === 0 ? 'RESULT: 0 failed' : `RESULT: ${failed} FAILED`);
process.exit(failed);
JS
echo "exit code : $?"

# --- R6 item 2: the new unit tests are RED on the pre-fix tree ------------
hdr "R6.2 -- the new unit tests are RED on the pre-fix tree (3bac3bd)"
BASELINE="3bac3bd"
SCRATCH="$TMPDIR/ats601-r3-red"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/tree"
if git cat-file -e "$BASELINE^{commit}" 2>/dev/null; then
  git archive "$BASELINE" | tar -x -C "$SCRATCH/tree"
  git show HEAD:tests/mobile-adapter.test.mjs > "$SCRATCH/tree/tests/mobile-adapter.test.mjs"
  ( cd "$SCRATCH/tree" && node --test tests/mobile-adapter.test.mjs tests/mobile-target.test.mjs 2>&1 \
      | grep -E '^(✖|ℹ (tests|pass|fail))' )
  echo "--- the control cases that must stay green on the pre-fix tree ---"
  ( cd "$SCRATCH/tree" && node --test tests/mobile-adapter.test.mjs tests/mobile-target.test.mjs 2>&1 \
      | grep -E '^✔ UT-MOB-09[0-4]' || echo '(none of the new cases pass on the pre-fix tree)' )
else
  echo "SKIPPED: the baseline commit $BASELINE is not in this clone"
fi

# --- R6 item 3: the gates on the delivered tree ---------------------------
hdr "R6.3a -- the mobile contract unit tests"
node --test tests/mobile-adapter.test.mjs tests/mobile-target.test.mjs 2>&1 | tail -10

hdr "R6.3b -- the mobile contract probe"
node tools/ats601-probes/probe-mobile-contract.mjs 2>&1 | tail -12
echo "exit code : $?"

hdr "R6.3c -- the line and branch coverage of the mobile contract"
node --test --experimental-test-coverage tests/mobile-adapter.test.mjs tests/mobile-target.test.mjs 2>&1 \
  | grep -E "mobile|all files|start of coverage|end of coverage|tests |pass |fail "

hdr "R6.3d -- the review probe (review-r1.mjs) against the delivered tree"
if [ -f "$PROBES/r2/review-r1.mjs" ]; then
  node "$PROBES_NATIVE/r2/review-r1.mjs" "$(pwd -W)" 2>&1
  echo "exit code : $?"
else
  echo "SKIPPED: $PROBES/r2/review-r1.mjs is not there"
fi

hdr "R6.3e -- the full regression (every test file)"
npm test 2>&1 | tail -12

hdr "R6.3f -- the ATS-301 gate"
bash tools/ats301-probes/check-ats301-gate.sh 2>&1 | tail -8
echo "exit code : $?"

hdr "R6.3g -- the remote protocol audit (rejection code table)"
node tools/ats501-probes/audit-remote-protocol.mjs 2>&1 | tail -8
echo "exit code : $?"

hdr "R6.3h -- the WBS updater coexistence regression"
bash tools/ats501-probes/check-wbs-updaters.sh 2>&1 | tail -8
echo "exit code : $?"

hdr "R6.3i -- the python gates under tools/"
python -m pytest tools/ -q 2>&1 | tail -6
echo "exit code : $?"

hdr "R6.3j -- the checksum manifest"
python tools/verify_checksums.py 2>&1 | tail -4
echo "exit code : $?"

hdr "done"
