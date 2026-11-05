#!/usr/bin/env bash
# ATS-102 -- evidence for review round 3.
#
# Usage: bash tools/ats102-probes/collect-evidence-round3.sh
#
# Writes one log into docs/evidence/ATS-102/:
#
#   17-line-ending-independent-digest.log
#       The installed-tree digest measured in TWO fresh clones of the SAME
#       commit, one checked out with CRLF (core.autocrlf=true) and one with
#       LF (core.autocrlf=false), plus the digest of the hidden lockfile
#       npm writes, and the `--check` verdict in each clone.
#
# The point of the comparison: the recorded digest must not depend on HOW git
# checked the tree out. Before the normalisation existed, npm wrote
# node_modules/.package-lock.json in the line-ending style of the lockfile it
# read, so the SAME tree had two different digests depending on the checkout
# and the recorded value only described the checkout it was measured in.
#
# The script needs a Node 22 tree on the PATH (the npm that ships with it).
# It is located by ATS_NODE22_DIR.

set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EV="${ATS_PROBE_EVIDENCE_DIR:-$ROOT/docs/evidence/ATS-102}"
WORK="${ATS_PROBE_WORKDIR:-$ROOT/.ats-evidence-work}"
mkdir -p "$EV" "$WORK"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()  { printf '%s\n' "$*"; }

NATIVE_ROOT="$(cd "$ROOT" && pwd -W 2>/dev/null || pwd)"
NPM10_DIR="${ATS_NODE22_DIR:-/d/hermes-multica/home/cache/scratch/node22/node-v22.23.4-win-x64}"

CRLF_CLONE="${ATS_PROBE_CRLF_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-eol-crlf-clone}"
LF_CLONE="${ATS_PROBE_LF_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-eol-lf-clone}"

{
  echo "=== ATS-102 evidence: the installed-tree digest does not depend on the checkout line-ending style ==="
  echo "date  : $(stamp)"
  echo "commit: $(git rev-parse --short HEAD)  $(git log --oneline -1 --format=%s)"
  echo "repo  : $NATIVE_ROOT"
  echo
  echo "TWO fresh clones of the SAME commit are installed with the SAME npm, and"
  echo "the digest is measured in each:"
  echo
  echo "  clone A: core.autocrlf=true   -> the working tree gets CRLF (Windows default)"
  echo "  clone B: core.autocrlf=false  -> the working tree stays LF"
  echo
  echo "The digest recipe hashes TEXT files with their line endings normalised to"
  echo "LF and BINARY files byte for byte, so the two clones must agree."
  echo
  echo "The line-ending style of the checkout is set per clone with"
  echo "  git -c core.autocrlf=true  clone ... / git -c core.autocrlf=false clone ..."
  echo "and the setting is re-applied after the clone, because git records the"
  echo "config of the machine that made the clone, not the one passed on the"
  echo "command line."
  echo

  for pair in "A:crlf:true:$CRLF_CLONE" "B:lf:false:$LF_CLONE"; do
    label="${pair%%:*}"; rest="${pair#*:}"
    style="${rest%%:*}"; rest="${rest#*:}"
    autocrlf="${rest%%:*}"; dest="${rest#*:}"

    echo "==================================================================="
    echo "[clone $label]  line-ending style: $style   core.autocrlf=$autocrlf"
    echo "                path: $dest"
    echo "==================================================================="
    rm -rf "$dest"
    git -c "core.autocrlf=$autocrlf" clone -q --no-hardlinks "$NATIVE_ROOT" "$dest" 2>&1 | sed 's/^/    /'
    (
      cd "$dest" || exit 1
      # Re-apply the setting to the clone's own config, so the working tree
      # is checked out with the line-ending style this clone is meant to have.
      git config core.autocrlf "$autocrlf"
      echo "cloned commit      : $(git rev-parse --short HEAD)  $(git log --oneline -1 --format=%s)"
      echo "core.autocrlf      : $(git config --get core.autocrlf)"
      echo
      echo "--- the checkout really has the intended line endings ---"
      printf '  package-lock.json CR bytes : '
      tr -cd '\r' < package-lock.json | wc -c
      printf '  apps/studio/package-lock.json CR bytes : '
      tr -cd '\r' < apps/studio/package-lock.json | wc -c
      echo
      echo "--- npm ci (apps/studio), same lockfile in both clones ---"
      PATH="/usr/bin:/bin:/mingw64/bin:$NPM10_DIR:/c/Windows/system32:/c/Windows:/c/Windows/System32/Wbem:/c/Windows/System32/WindowsPowerShell/v1.0:/c/Program Files/nodejs"
      export PATH
      export npm_config_registry="https://registry.npmjs.org/"
      echo "node : $(node --version)"
      echo "npm  : $(npm --version)"
      ( cd apps/studio && npm ci --no-audit --no-fund ) 2>&1 | tail -3
      echo
      echo "--- the hidden lockfile npm wrote (this is where the line endings differ) ---"
      python - "$dest" <<'PY' 2>&1 | sed 's/^/    /'
import hashlib, sys
p = sys.argv[1] + '/apps/studio/node_modules/.package-lock.json'
d = open(p, 'rb').read()
lf = d.replace(b'\r\n', b'\n')
print('.package-lock.json bytes      :', len(d))
print('.package-lock.json CR bytes   :', d.count(b'\r'))
print('.package-lock.json raw sha256 :', hashlib.sha256(d).hexdigest())
print('.package-lock.json LF-norm    :', hashlib.sha256(lf).hexdigest())
PY
      echo
      echo "--- the measured digests ---"
      node tools/tree_digest.mjs apps/studio/node_modules 2>&1 | sed 's/^/    /'
      node tools/tree_digest.mjs apps/studio/node_modules --package-json-only 2>&1 | sed 's/^/    /'
      echo
      echo "--- the gate's own digest check (installdigest) ---"
      node tools/tree_digest.mjs --check apps/studio/node_modules 2>&1 | sed 's/^/    /'
      echo "    exit code = ${PIPESTATUS[0]}"
      echo
    )
    echo
  done

  echo "==================================================================="
  echo "the two clones, side by side"
  echo "==================================================================="
  echo
  echo "The digests above must be IDENTICAL between clone A (CRLF) and clone B (LF)."
  echo "The raw sha256 of the hidden lockfile must DIFFER between them -- that is"
  echo "the effect that the normalisation undoes."
  echo
} > "$EV/17-line-ending-independent-digest.log" 2>&1

say "wrote $EV/17-line-ending-independent-digest.log"
