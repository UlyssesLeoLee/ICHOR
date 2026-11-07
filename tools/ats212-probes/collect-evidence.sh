#!/usr/bin/env bash
# Collect the ATS-212 evidence logs over the CURRENT tree.
#
# usage: bash tools/ats212-probes/collect-evidence.sh
#
# Every log lands in docs/evidence/ATS-212/. The point of this script is that
# the delivered evidence describes the tree that is actually delivered -- the
# logs must be collected on the delivered tree, not on a pre-merge branch.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
EV=docs/evidence/ATS-212
mkdir -p "$EV"

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

# The probes and the test suites need a WRITABLE temp directory. The system
# temp on this host lives on C:, which has been full more than once -- a full
# temp makes the coverage file and the probe fixtures fail even though every
# test passed. The scratch dir is used when it exists.
if [ -n "${ATS212_SCRATCH:-}" ] && [ -d "${ATS212_SCRATCH:-}" ]; then
  export TMPDIR="$ATS212_SCRATCH"
  export TEMP="$ATS212_SCRATCH"
  export TMP="$ATS212_SCRATCH"
fi

run() { # run <logfile> <label> <command...>
  local out="$1" label="$2"; shift 2
  local rc=0
  {
    echo "=== $label ==="
    echo "repo root : $(pwd)"
    echo "commit    : $(git rev-parse --short HEAD)"
    echo "branch    : $(git branch --show-current)"
    echo "node      : $(node --version)"
    echo "python    : $(python --version 2>&1)"
    echo
  } > "$EV/$out"
  # The exit code of the command has to be captured IMMEDIATELY after it
  # runs: `$?` after the trailing `echo` is the exit code of that `echo`,
  # which is always 0. A log that always claims 0 is worse than no log.
  "$@" >> "$EV/$out" 2>&1 || rc=$?
  {
    echo
    echo "exit code : $rc"
  } >> "$EV/$out"
  if [ "$rc" -ne 0 ]; then
    echo "wrote $EV/$out (FAILED with exit code $rc)"
  else
    echo "wrote $EV/$out"
  fi
}

# --- 01 / 02 / 03: the unit suites of this task -----------------------------
run 01-node-test-env-ut.log "the environment profile unit suite" \
  node --test tests/env.test.mjs
run 02-node-test-env-sqlite-ut.log "the environment profile SQLite suite" \
  node --test tests/env-sqlite.test.mjs
run 03-node-test-env-adapter-it.log "the environment profile adapter suite" \
  node --test tests/env-adapter.test.mjs

# --- 04: the API integration suite ------------------------------------------
run 04-node-test-env-api-it.log "the environment profile API suite" \
  node --test tests/env-api.test.mjs

# --- 05: the full test suite ------------------------------------------------
run 05-node-test-full.log "the full node test suite" npm test

# --- 06: the probe of this task ---------------------------------------------
# The probe MEASURES the behaviour against the acceptance criteria: the
# whitelist refusal, the credential refusal, the sealed child environment,
# the run record and the manifest.
run 06-probe-env-seal.log "the environment seal: what the runner child received" \
  node tools/ats212-probes/probe-env-seal.mjs

# --- 06b: the A/B comparison of the LISTING environment ---------------------
# The seal also applies to the LISTING child (the `playwright test --list`
# process), not only to the runner. This probe installs a REAL Playwright
# into a throwaway project and runs the listing twice per round -- once
# with the sealed environment (BASE_ENV_KEYS only) and once with the host
# environment -- so the delivered evidence shows that sealing the listing
# child does not break the listing.
run 06b-ab-listing-env.log "the listing environment: sealed vs. host, A/B over 5 rounds" \
  node tools/ats212-probes/ab-listing-env.mjs 5

# --- 06c: the mirror after the migration -----------------------------------
# The requirement is "after the migration `verifyMirror` must still be OK".
# The migration re-keys the environment profiles and the whitelists, so the
# mirror has to follow -- and this probe MEASURES it.
run 06c-probe-mirror-after-migration.log \
  "the SQLite mirror after the state migration re-keys the profiles" \
  node tools/ats212-probes/probe-mirror-after-migration.mjs

# --- 06d: the whitelist filter of the run path ------------------------------
# The requirement is "a name removed from the whitelist no longer reaches
# the runner". This probe measures it at the level of the runner environment,
# without a browser.
run 06d-probe-whitelist-filters-run.log \
  "the whitelist filters the runner environment, not only the write" \
  node tools/ats212-probes/probe-whitelist-filters-run.mjs

# --- 07: the ADR citation check ---------------------------------------------
run 07-adr-citations.log "the ADR citation check" \
  python tools/check_adr_citations.py

# --- 08: the ATS-301 quality gate -------------------------------------------
run 08-quality-gates.log "the ATS-301 gate: WBS helper + ADR citations + port audit" \
  bash tools/ats301-probes/check-ats301-gate.sh

# --- 09: the WBS row of this task -------------------------------------------
run 09-wbs-row.log "the ATS-212 row of docs/WBS.xlsx" \
  python tools/update_wbs_ats212.py

# --- 09b: the row 33 acceptance check ---------------------------------------
# The WBS note has to describe the DELIVERED behaviour only: a note that
# narrates the defects that were found and fixed along the way documents an
# intermediate state that no longer exists. This check asserts that the T
# cell of row 33 carries no such narrative, that the two regression numbers
# are unchanged, and that the updater is idempotent.
run 09b-wbs-row33-check.log \
  "the ATS-212 row 33: final state only, unchanged numbers, idempotent updater" \
  python tools/ats212-probes/check-wbs-row33.py

# --- 10: the python gates ----------------------------------------------------
run 10-python-gates.log "the python gates under tools/" \
  python -m pytest tools/ -q

# --- 11: the baseline regression comparison --------------------------------
# The no-regression claim needs a MEASURED baseline, not a remembered number.
# ATS212_BASELINE is a worktree at the commit where ATS-212 had not landed
# yet; the same suite is run there and the two totals are printed side by
# side. Without it the "no regression" line is an assertion.
if [ -n "${ATS212_BASELINE:-}" ] && [ -d "${ATS212_BASELINE:-}" ]; then
  run 11-baseline-regression.log "the full suite on the pre-ATS-212 baseline, for the no-regression claim" \
    env -C "$ATS212_BASELINE" npm test
else
  {
    echo "=== the full suite on the pre-ATS-212 baseline, for the no-regression claim ==="
    echo "SKIPPED: ATS212_BASELINE is not set to a baseline worktree."
    echo "The no-regression claim therefore rests on the current tree's totals alone."
    echo
    echo "exit code : 0"
  } > "$EV/11-baseline-regression.log"
  echo "wrote $EV/11-baseline-regression.log (skipped)"
fi

# --- 12: the checksum verification -------------------------------------------
# NOT HERE, ON PURPOSE. The manifest lists the evidence logs, so a log that
# records the manifest's own verification cannot live inside the manifest it
# describes: writing the log changes the log's digest, which changes the
# manifest, which invalidates the log. The verification is therefore the
# LAST step of the delivery, run after the manifest has been regenerated
# over the final tree:
#
#   python tools/update_checksums.py   # over the committed tree
#   python tools/verify_checksums.py   # independent verification
#
# ATS-208 uses the same arrangement (its evidence set has no checksum log
# either); the ATS-301 LF-clone log exists only because it was collected in
# a SEPARATE clone and never entered the manifest it verifies.
echo "the checksum verification is a post-commit gate, not an evidence step (see the header)"

echo "done"
