#!/usr/bin/env bash
# Collect the evidence for the 3rd review round (review comment
# 01a1abb7-1af9-7ee6-ac53-e1be94f301de).
#
# The 3rd review rejected the delivery on four blockers, and three of them
# were only visible in a checkout that is NOT the machine the previous round
# was run on:
#
#   D1  a clean checkout has no examples/sample-playwright/node_modules, so
#       IT-API-013 asserted a negotiation that needs the engine and failed
#       -> the CI "npm test" step would be red;
#   D2  the workflow gained a step the local gate did not run, so the
#       "local gate == workflow" claim stopped holding;
#   D3  verify_checksums.py split the manifest on CRLF only, so an LF
#       checkout (autocrlf=false, and every Linux / macOS checkout) read the
#       whole manifest as ONE line and reported a bogus MISMATCH.
#
# A claim that is only verified in one environment is not verified. So this
# script builds the two checkouts the reviewer used -- a clean one and an LF
# one -- and runs the checks IN them:
#
#   12-clean-clone-npm-test.log
#       a fresh clone of the current commit, with NO node_modules anywhere,
#       running `npm test`. The expectations are: 0 fail, and the skips
#       listed explicitly.
#
#   13-lf-clone-verify-checksums.log
#       a fresh clone with core.autocrlf=false, so the manifest keeps the
#       committed blob's LF bytes, running `python tools/verify_checksums.py`.
#       The expectation is: RESULT: OK.
#
#   14-workflow-gate-parity.log
#       `node tools/ci_build_gate.mjs --check-parity`, which reads
#       .github/workflows/ats-102-build.yml and compares every `run:`
#       command with the commands the local gate issues.
#
# Both clones are made from the CURRENT COMMIT, so the evidence describes
# the tree that is being delivered and not some earlier one.
#
# Usage: bash tools/ats301-probes/collect-review4-evidence.sh
set -u

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
EV="$ROOT/docs/evidence/ATS-301"
mkdir -p "$EV"

# The clones are built OUTSIDE the repository, so their own working trees
# never end up in the manifest or in the commit.
WORK="${ATS301_EVIDENCE_WORKDIR:-${TMPDIR:-$ROOT/.ats-evidence-work}/ats301-review4}"
mkdir -p "$WORK"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
repo_head() { git rev-parse HEAD; }

printf '=== ATS-301 review-round-4 evidence ===\n'
printf 'repo root : %s\n' "$ROOT"
printf 'repo head : %s\n' "$(repo_head)"
printf 'work dir  : %s\n' "$WORK"
printf 'node      : %s\n' "$(node --version 2>&1)"
printf 'date      : %s\n' "$(stamp)"
printf '\n'

# ---------------------------------------------------------------------------
# 12. a clean checkout: npm test, with no fixture installed anywhere.
# ---------------------------------------------------------------------------
CLEAN="$WORK/clean-clone"
rm -rf "$CLEAN"
{
  echo "=== ATS-301 / D1: npm test on a CLEAN checkout ==="
  echo
  echo "CONDITIONS (the reviewer asked for these to be stated explicitly):"
  echo "  commit            : $(repo_head)"
  echo "  clone             : fresh local clone (git clone --no-hardlinks)"
  echo "  fixtures installed: NONE -- no npm install was run, so"
  echo "                      examples/sample-playwright/node_modules does"
  echo "                      NOT exist, and neither does apps/studio/node_modules"
  echo "  node              : $(node --version 2>&1)"
  echo "  npm               : $(npm --version 2>&1)"
  echo "  platform          : $(node -p 'process.platform + " " + process.arch' 2>&1)"
  echo "  date              : $(stamp)"
  echo
  echo "WHY THIS RUN MATTERS:"
  echo "  The 3rd review found that IT-API-013 asserted a negotiation that"
  echo "  needs the Playwright engine to be installed. CI installs only the"
  echo "  root and apps/studio, so the CI 'npm test' step was red. This run"
  echo "  is the checkout CI sees."
  echo
  echo "COMMAND: npm test"
  echo

  git clone --no-hardlinks "$ROOT" "$CLEAN" >/dev/null 2>&1
  if [ ! -d "$CLEAN/.git" ]; then
    echo "RESULT: COULD NOT CLONE -- the clean checkout was not created."
    exit 1
  fi

  cd "$CLEAN" || exit 1
  echo "--- the checkout state ---"
  echo "HEAD: $(git rev-parse HEAD)"
  echo "root node_modules present : $([ -d node_modules ] && echo yes || echo no)"
  echo "apps/studio/node_modules   : $([ -d apps/studio/node_modules ] && echo yes || echo no)"
  echo "sample-playwright/node_modules: $([ -d examples/sample-playwright/node_modules ] && echo yes || echo no)"
  echo
  echo "--- npm test ---"
  npm test 2>&1
  echo
  echo "--- the summary line ---"
  npm test 2>&1 | grep -E '^. (tests|pass|fail|skipped) '
  echo
  echo "--- the IT-API-013 tests, verbatim ---"
  npm test 2>&1 | grep -E 'IT-API-013'
} > "$EV/12-clean-clone-npm-test.log" 2>&1
printf '12-clean-clone-npm-test.log exit=%s\n' "$?"

# ---------------------------------------------------------------------------
# 13. an LF checkout: the manifest keeps its committed LF bytes.
# ---------------------------------------------------------------------------
LFCLONE="$WORK/lf-clone"
rm -rf "$LFCLONE"
{
  echo "=== ATS-301 / D3: verify_checksums.py on an LF checkout ==="
  echo
  echo "CONDITIONS (the reviewer asked for these to be stated explicitly):"
  echo "  commit             : $(repo_head)"
  echo "  clone              : fresh local clone (git clone --no-hardlinks)"
  echo "  core.autocrlf      : false  (set AT CLONE TIME, so the checkout"
  echo "                        itself is written with LF)"
  echo "  core.eol           : lf"
  echo "  fixtures installed : NONE (not relevant to this check)"
  echo "  node               : $(node --version 2>&1)"
  echo "  python             : $(python -c 'import sys; print(sys.version.replace(chr(10), " "))' 2>&1)"
  echo "  date               : $(stamp)"
  echo
  echo "WHY THIS RUN MATTERS:"
  echo "  The 3rd review found that verify_checksums.py split the manifest on"
  echo "  CRLF only. The committed blob of CHECKSUMS.sha256 is LF, so an"
  echo "  autocrlf=false checkout -- and every Linux / macOS checkout -- read"
  echo "  the whole manifest as ONE line and reported a bogus MISMATCH"
  echo "  (tracked-not-listed: 197). The previous round only ever verified"
  echo "  the CRLF case."
  echo

  # core.autocrlf=false AT CLONE TIME: setting it afterwards is too late,
  # because the working tree has already been written.
  git -c core.autocrlf=false -c core.eol=lf clone --no-hardlinks "$ROOT" "$LFCLONE" >/dev/null 2>&1
  if [ ! -d "$LFCLONE/.git" ]; then
    echo "RESULT: COULD NOT CLONE -- the LF checkout was not created."
    exit 1
  fi

  cd "$LFCLONE" || exit 1
  git config core.autocrlf false
  git config core.eol lf
  echo "--- the checkout state ---"
  echo "HEAD: $(git rev-parse HEAD)"
  echo "core.autocrlf: $(git config core.autocrlf)"
  echo "core.eol: $(git config core.eol)"
  echo
  echo "--- the manifest's line terminators in THIS checkout ---"
  python - <<'PY'
b = open('CHECKSUMS.sha256', 'rb').read()
crlf = b.count(b'\r\n')
lf = b.count(b'\n') - crlf
print(f'CHECKSUMS.sha256 : {len(b)} bytes, {crlf} CRLF, {lf} bare LF')
if lf and not crlf:
    print('=> this is the LF case the reviewer reported as broken')
elif crlf and not lf:
    print('=> this is the CRLF case')
else:
    print('=> MIXED -- unexpected')
PY
  echo
  echo "--- the committed blob (the bytes git actually stores) ---"
  git cat-file blob HEAD:CHECKSUMS.sha256 | python -c "
import sys
b = sys.stdin.buffer.read()
crlf = b.count(b'\r\n')
lf = b.count(b'\n') - crlf
print(f'blob : {len(b)} bytes, {crlf} CRLF, {lf} bare LF')
"
  echo
  echo "COMMAND: python tools/verify_checksums.py"
  echo
  python tools/verify_checksums.py 2>&1
} > "$EV/13-lf-clone-verify-checksums.log" 2>&1
printf '13-lf-clone-verify-checksums.log exit=%s\n' "$?"

# ---------------------------------------------------------------------------
# 14. the workflow / local gate parity.
# ---------------------------------------------------------------------------
{
  echo "=== ATS-301 / D2: the local build gate vs the CI workflow ==="
  echo
  echo "CONDITIONS:"
  echo "  commit : $(repo_head)"
  echo "  node   : $(node --version 2>&1)"
  echo "  date   : $(stamp)"
  echo
  echo "WHAT THIS CHECKS:"
  echo "  tools/ci_build_gate.mjs claims in its header to run EXACTLY the"
  echo "  steps that .github/workflows/ats-102-build.yml runs. The 3rd review"
  echo "  found the claim no longer held: the workflow had gained the"
  echo "  'Run the ATS-301 gate' step and the local gate had not."
  echo
  echo "  A comment cannot fail, so the claim is now CHECKED: this mode reads"
  echo "  the workflow file and compares every 'run:' command with the"
  echo "  commands the local gate issues, in both directions."
  echo
  echo "COMMAND: node tools/ci_build_gate.mjs --check-parity"
  echo
  node tools/ci_build_gate.mjs --check-parity 2>&1
  echo
  echo "--- the local gate's step list, for the side-by-side ---"
  echo "COMMAND: node tools/ci_build_gate.mjs --list"
  echo
  node tools/ci_build_gate.mjs --list 2>&1
  echo
  echo "--- the workflow's run commands, as read from the YAML ---"
  grep -nE '^\s+- name:|^\s+run:' .github/workflows/ats-102-build.yml
} > "$EV/14-workflow-gate-parity.log" 2>&1
printf '14-workflow-gate-parity.log exit=%s\n' "$?"

rm -rf "$WORK"
printf 'done.\n'
