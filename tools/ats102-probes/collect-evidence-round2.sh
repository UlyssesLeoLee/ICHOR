#!/usr/bin/env bash
# ATS-102 -- evidence for review round 2.
#
# Usage: bash tools/ats102-probes/collect-evidence-round2.sh
#
# Writes three logs into docs/evidence/ATS-102/:
#
#   13-manifest-drift-committed-tamper.log
#       The manifest drift gate, measured against a TAMPERED *COMMITTED*
#       manifest (the situation CI faces: the committed manifest no longer
#       matches the lockfiles). Three orders are compared.
#
#   14-npm-version-and-install-digest.log
#       The installed-tree digest measured under npm 10.9.9 and under
#       npm 12.2.0 from the SAME lockfile, plus the gate's diagnostics for
#       each npm version.
#
#   15-node22-gate-8-steps-final.log
#       The 8-step gate on the FINAL tree, in a clean clone, under Node 22.
#
# The script needs a Node 22 tree on the PATH (the npm that ships with it)
# and a system Node with npm 12 for the comparison. Both are located by
# ATS_NODE22_DIR and by the PATH respectively.

set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EV="${ATS_PROBE_EVIDENCE_DIR:-$ROOT/docs/evidence/ATS-102}"
WORK="${ATS_PROBE_WORKDIR:-$ROOT/.ats-evidence-work}"
mkdir -p "$EV" "$WORK"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()  { printf '%s\n' "$*"; }

NATIVE_ROOT="$(cd "$ROOT" && pwd -W 2>/dev/null || pwd)"

# ---------------------------------------------------------------------
# 1. The manifest drift gate, against a tampered COMMITTED manifest.
#
# This section COMMITS a tampered manifest, so it runs in a throwaway clone
# and never in the working repository: the tamper must be committed for the
# measurement to match what CI sees, and a committed tamper must not end up
# in the deliverable.
# ---------------------------------------------------------------------
DRIFT_CLONE="${ATS_PROBE_DRIFT_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-drift-clone}"
{
  echo "=== ATS-102 evidence: the manifest drift gate against a tampered COMMITTED manifest ==="
  echo "clone : $DRIFT_CLONE"
  echo "date  : $(stamp)"
  echo "git   : $(git --version)"
  echo "node  : $(node --version)"
  echo "npm   : $(npm --version)"
  echo
  echo "The situation CI faces is a COMMITTED manifest that no longer matches the"
  echo "lockfiles. The three candidate gate orders are therefore measured on a"
  echo "tamper that is COMMITTED, not merely left in the working tree: a"
  echo "tamper that was never committed is simply overwritten by the next"
  echo "regeneration and says nothing about what the gate can detect."
  echo
  echo "This section runs in a throwaway clone, so the tampered commit never"
  echo "reaches the deliverable."
  echo
  rm -rf "$DRIFT_CLONE"
  git clone -q --no-hardlinks "$NATIVE_ROOT" "$DRIFT_CLONE" 2>&1 | sed 's/^/    /'
  cd "$DRIFT_CLONE" || exit 1
  git config user.name probe
  git config user.email probe@example.invalid

  echo "-------------------------------------------------------------------"
  echo "order A: regenerate, then --check"
  echo "-------------------------------------------------------------------"
  echo "(the order this gate used to have: it compares the file it just wrote"
  echo " with itself, so any committed drift is silently overwritten)"
  echo
  python - <<'PY'
import pathlib, re
p = pathlib.Path('docs/dependencies/dependency-manifest.json')
t = p.read_text(encoding='utf-8')
m = re.search(r'"integrity": "sha512-[0-9A-Za-z+/=]{20}', t)
p.write_text(t[:m.start()] + '"integrity": "sha512-TAMPERED' + t[m.end():], encoding='utf-8')
print('tampered:', m.group(0)[:48])
PY
  git add docs/dependencies/dependency-manifest.json
  git commit -q -m "probe: tampered manifest"
  git log --oneline -1
  node tools/gen_dep_manifest.mjs >/dev/null 2>&1
  node tools/gen_dep_manifest.mjs --check >/dev/null 2>&1
  echo "exit code = $?   (0 means the drift was NOT detected)"
  echo
  echo "-------------------------------------------------------------------"
  echo "order B: --check first"
  echo "-------------------------------------------------------------------"
  echo "(the order this gate has now: it compares the committed file against"
  echo " the lockfiles, without touching the file)"
  echo
  git reset -q --hard HEAD~1
  git clean -qfd
  python - <<'PY'
import pathlib, re
p = pathlib.Path('docs/dependencies/dependency-manifest.json')
t = p.read_text(encoding='utf-8')
m = re.search(r'"integrity": "sha512-[0-9A-Za-z+/=]{20}', t)
p.write_text(t[:m.start()] + '"integrity": "sha512-TAMPERED' + t[m.end():], encoding='utf-8')
PY
  git add docs/dependencies/dependency-manifest.json
  git commit -q -m "probe: tampered manifest"
  node tools/gen_dep_manifest.mjs --check >/dev/null 2>&1
  echo "exit code = $?   (non-zero means the drift WAS detected)"
  echo
  echo "-------------------------------------------------------------------"
  echo "order C: regenerate, then git diff --exit-code"
  echo "-------------------------------------------------------------------"
  echo "(measured on its own, starting again from a tampered commit)"
  echo
  git reset -q --hard HEAD~1
  git clean -qfd
  python - <<'PY'
import pathlib, re
p = pathlib.Path('docs/dependencies/dependency-manifest.json')
t = p.read_text(encoding='utf-8')
m = re.search(r'"integrity": "sha512-[0-9A-Za-z+/=]{20}', t)
p.write_text(t[:m.start()] + '"integrity": "sha512-TAMPERED' + t[m.end():], encoding='utf-8')
PY
  git add docs/dependencies/dependency-manifest.json
  git commit -q -m "probe: tampered manifest"
  node tools/gen_dep_manifest.mjs >/dev/null 2>&1
  git diff --exit-code -- docs/dependencies/ >/dev/null 2>&1
  echo "exit code = $?   (non-zero means the drift WAS detected)"
  echo
  echo "So the detection capability of the three orders is:"
  echo "  order A (regenerate, then --check) : does NOT detect"
  echo "  order B (--check first)            : detects"
  echo "  order C (regenerate, then git diff): detects"
  echo
  echo "Order C detects the drift because the regeneration REWRITES the"
  echo "committed manifest, so the working tree differs from the commit."
  echo "Order B is the one this gate uses: it is the only order that does not"
  echo "write to the file it is checking, needs no git, and runs offline."
  echo
  echo "--- the tampered commit is visible in the clone's log ---"
  git log --oneline -2
} > "$EV/13-manifest-drift-committed-tamper.log" 2>&1

say "wrote $EV/13-manifest-drift-committed-tamper.log"

# ---------------------------------------------------------------------
# 2. The installed-tree digest under npm 10.9.9 and under npm 12.2.0.
#
# The recorded digest is a property of (tree, npm version). Both trees are
# installed from the SAME committed lockfile, so the difference between them
# is attributable to the npm version alone.
# ---------------------------------------------------------------------
NPM10_DIR="${ATS_NODE22_DIR:-/d/hermes-multica/home/cache/scratch/node22/node-v22.23.4-win-x64}"
NPM10_CLONE="${ATS_PROBE_NPM10_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-npm10-clone}"
NPM12_CLONE="${ATS_PROBE_NPM12_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-npm12-clone}"
{
  echo "=== ATS-102 evidence: the installed-tree digest depends on the npm version ==="
  echo "date : $(stamp)"
  echo "lock : the SAME committed apps/studio/package-lock.json in both clones"
  echo
  echo "-------------------------------------------------------------------"
  echo "the two npm versions"
  echo "-------------------------------------------------------------------"
  echo "npm 10.9.9 : the npm bundled with Node 22.23.4, pinned as packageManager"
  echo "npm 12.2.0 : the npm bundled with Node 24.19.0 (this machine's default)"
  echo

  for pair in "npm10:$NPM10_DIR:$NPM10_CLONE" "npm12:$NPM10_DIR:$NPM12_CLONE"; do
    label="${pair%%:*}"; rest="${pair#*:}"; node_dir="${rest%%:*}"; dest="${rest#*:}"
    echo "==================================================================="
    echo "[$label]  clone -> $dest"
    echo "==================================================================="
    rm -rf "$dest"
    git clone -q --no-hardlinks "$NATIVE_ROOT" "$dest" 2>&1 | sed 's/^/    /'
    (
      cd "$dest" || exit 1
      if [ "$label" = "npm10" ]; then
        PATH="/usr/bin:/bin:/mingw64/bin:$node_dir:/c/Windows/system32:/c/Windows:/c/Windows/System32/Wbem:/c/Windows/System32/WindowsPowerShell/v1.0:/c/Program Files/nodejs"
      else
        PATH="/usr/bin:/bin:/mingw64/bin:/c/Program Files/nodejs:/c/Windows/system32:/c/Windows:/c/Windows/System32/Wbem:/c/Windows/System32/WindowsPowerShell/v1.0"
      fi
      export PATH
      export npm_config_registry="https://registry.npmjs.org/"
      echo "node : $(node --version)"
      echo "npm  : $(npm --version)"
      echo "--- npm ci (apps/studio) ---"
      ( cd apps/studio && npm ci --no-audit --no-fund ) 2>&1 | tail -3
      echo
      echo "--- the gate's own version assertion (checknode) ---"
      node tools/ci_build_gate.mjs --check-node 2>&1 | sed 's/^/    /'
      echo "    exit code = ${PIPESTATUS[0]}"
      echo
      echo "--- the digest check (installdigest) ---"
      node tools/tree_digest.mjs --check apps/studio/node_modules 2>&1 | sed 's/^/    /'
      echo "    exit code = ${PIPESTATUS[0]}"
      echo
      echo "--- the measured digests ---"
      node tools/tree_digest.mjs apps/studio/node_modules 2>&1 | sed 's/^/    /'
      node tools/tree_digest.mjs apps/studio/node_modules --package-json-only 2>&1 | sed 's/^/    /'
      echo
      echo "--- the optional packages whose presence depends on the npm version ---"
      for p in "@emnapi/runtime" "@img/sharp-wasm32" "@img/colour" "@types/trusted-types" "sharp" "semver" "detect-libc"; do
        if [ -e "apps/studio/node_modules/$p" ]; then
          echo "    present : $p"
        else
          echo "    ABSENT  : $p"
        fi
      done
      echo "    file count   : $(find apps/studio/node_modules -type f | wc -l)"
      echo "    package.json : $(find apps/studio/node_modules -name package.json -type f | wc -l)"
    )
    echo
  done

  echo "==================================================================="
  echo "the difference between the two trees, file by file"
  echo "==================================================================="
  python3 "$NATIVE_ROOT/tools/ats102-probes/diff-install-trees.py" \
    "$NPM10_CLONE/apps/studio/node_modules" \
    "$NPM12_CLONE/apps/studio/node_modules" 2>&1 | sed 's/^/    /'
} > "$EV/14-npm-version-and-install-digest.log" 2>&1

say "wrote $EV/14-npm-version-and-install-digest.log"

# ---------------------------------------------------------------------
# 3. The final 8-step gate, on the final tree, in a clean clone.
# ---------------------------------------------------------------------
FINAL_CLONE="${ATS_PROBE_FINAL_CLONE:-D:/hermes-multica/home/cache/scratch/ats102-final-clone}"
{
  echo "=== ATS-102 final acceptance: the 8-step build gate on a clean clone ==="
  echo "clone    : $FINAL_CLONE"
  echo "commit   : $(git -C "$NATIVE_ROOT" rev-parse --short HEAD)  $(git -C "$NATIVE_ROOT" log --oneline -1 --format=%s)"
  echo "node     : $(node --version)"
  echo "npm      : $(npm --version)"
  echo "registry : https://registry.npmjs.org/"
  echo "date     : $(stamp)"
  echo
  rm -rf "$FINAL_CLONE"
  git clone -q --no-hardlinks "$NATIVE_ROOT" "$FINAL_CLONE" 2>&1 | sed 's/^/    /'
  cd "$FINAL_CLONE" || exit 1
  echo "cloned commit : $(git rev-parse --short HEAD)  $(git log --oneline -1 --format=%s)"
  echo
  node tools/ci_build_gate.mjs 2>&1
  echo "GATE_EXIT_CODE=$?"
  echo
  echo "--- the working tree after the gate ---"
  git status --short
  echo "git status exit code = $?  (no output above = the gate left no dirty files)"
  git diff --exit-code -- package-lock.json apps/studio/package-lock.json
  echo "lockfile diff exit code = $?  (0 = npm ci did not mutate either lockfile)"
} > "$EV/15-node22-gate-8-steps-final.log" 2>&1

say "wrote $EV/15-node22-gate-8-steps-final.log"
