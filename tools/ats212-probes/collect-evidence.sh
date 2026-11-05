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

run() { # run <logfile> <label> <command...>
  local out="$1" label="$2"; shift 2
  {
    echo "=== $label ==="
    echo "repo root : $(pwd)"
    echo "commit    : $(git rev-parse --short HEAD)"
    echo "branch    : $(git branch --show-current)"
    echo "node      : $(node --version)"
    echo "python    : $(python --version 2>&1)"
    echo
    "$@" 2>&1
    echo
    echo "exit code : $?"
  } > "$EV/$out"
  echo "wrote $EV/$out"
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

# --- 07: the ADR citation check ---------------------------------------------
run 07-adr-citations.log "the ADR citation check" \
  python tools/check_adr_citations.py

# --- 08: the ATS-301 quality gate -------------------------------------------
run 08-quality-gates.log "the ATS-301 gate: WBS helper + ADR citations + port audit" \
  bash tools/ats301-probes/check-ats301-gate.sh

# --- 09: the WBS row of this task -------------------------------------------
run 09-wbs-row.log "the ATS-212 row of docs/WBS.xlsx" \
  python tools/update_wbs_ats212.py

# --- 10: the python gates ----------------------------------------------------
run 10-python-gates.log "the python gates under tools/" \
  python -m pytest tools/ -q

# --- 11: the checksum verification -------------------------------------------
run 11-checksums.log "the CHECKSUMS.sha256 verification against the committed tree" \
  python tools/verify_checksums.py

echo "done"
