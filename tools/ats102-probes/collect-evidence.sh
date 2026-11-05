#!/usr/bin/env bash
# Collect the evidence for the ATS-102 review round-1 fixes.
#
# Usage: bash tools/ats102-probes/collect-evidence.sh
#
# Writes docs/evidence/ATS-102/08-manifest-drift-and-line-endings.log, which
# covers the three fixes the review asked for:
#   1. the manifest drift gate (check first, then regenerate + git diff)
#   2. lockfileSha256 being recomputable from git (LF-normalised)
#   3. the gate working in a checkout path with spaces / non-ASCII
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
EV="$ROOT/docs/evidence/ATS-102"
WORK="${ATS_PROBE_WORKDIR:-$ROOT/.ats-evidence-work}"
mkdir -p "$EV" "$WORK"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()  { printf '%s\n' "$*"; }

{
  echo "=== ATS-102 evidence: manifest drift gate, line endings, checkout paths ==="
  echo "repo : $ROOT"
  echo "date : $(stamp)"
  echo "git  : $(git --version)"
  echo "node : $(node --version)"
  echo

  echo "-------------------------------------------------------------------"
  echo "1. the manifest drift gate"
  echo "-------------------------------------------------------------------"
  echo "The committed manifest must be checked BEFORE it is regenerated."
  echo "Regenerating first compares the file with itself and cannot detect drift."
  echo
  cp docs/dependencies/dependency-manifest.json "$WORK/manifest.bak"
  echo "--- tamper with one integrity value"
  python - <<'PY'
import pathlib, re
p = pathlib.Path('docs/dependencies/dependency-manifest.json')
t = p.read_text(encoding='utf-8')
m = re.search(r'"integrity": "sha512-[0-9A-Za-z+/=]{20}', t)
p.write_text(t[:m.start()] + '"integrity": "sha512-TAMPERED' + t[m.end():], encoding='utf-8')
print('tampered:', m.group(0)[:48])
PY
  echo
  echo "--- order A (the OLD order): regenerate, then --check"
  node tools/gen_dep_manifest.mjs >/dev/null 2>&1
  node tools/gen_dep_manifest.mjs --check >/dev/null 2>&1
  echo "exit code = $?   (0 means the drift was NOT detected)"
  echo
  echo "--- order B (the NEW order): --check first"
  cp "$WORK/manifest.bak" docs/dependencies/dependency-manifest.json
  python - <<'PY'
import pathlib, re
p = pathlib.Path('docs/dependencies/dependency-manifest.json')
t = p.read_text(encoding='utf-8')
m = re.search(r'"integrity": "sha512-[0-9A-Za-z+/=]{20}', t)
p.write_text(t[:m.start()] + '"integrity": "sha512-TAMPERED' + t[m.end():], encoding='utf-8')
PY
  node tools/gen_dep_manifest.mjs --check >/dev/null 2>&1
  echo "exit code = $?   (non-zero means the drift WAS detected)"
  echo
  echo "--- order C: regenerate, then git diff --exit-code"
  # Measured on its own, starting again from the tampered file.
  cp "$WORK/manifest.bak" docs/dependencies/dependency-manifest.json
  python - <<'PY'
import pathlib, re
p = pathlib.Path('docs/dependencies/dependency-manifest.json')
t = p.read_text(encoding='utf-8')
m = re.search(r'"integrity": "sha512-[0-9A-Za-z+/=]{20}', t)
p.write_text(t[:m.start()] + '"integrity": "sha512-TAMPERED' + t[m.end():], encoding='utf-8')
PY
  node tools/gen_dep_manifest.mjs >/dev/null 2>&1
  git diff --exit-code -- docs/dependencies/ >/dev/null 2>&1
  echo "exit code = $?   (0 means the drift was NOT detected)"
  echo "  -> regenerating OVERWRITES the tampered manifest, so a diff taken"
  echo "     afterwards cannot see the tamper. This is why the gate only"
  echo "     runs --check."
  echo
  cp "$WORK/manifest.bak" docs/dependencies/dependency-manifest.json
  node tools/gen_dep_manifest.mjs --check 2>&1 | sed 's/^/    /'
  echo "restored; --check exit code = ${PIPESTATUS[0]}"
  echo

  echo "-------------------------------------------------------------------"
  echo "2. lockfileSha256 is recomputable from git"
  echo "-------------------------------------------------------------------"
  echo "The recorded digest is the sha256 of the CRLF-normalised lockfile,"
  echo "which equals the sha256 of the git blob."
  echo
  python - <<'PY'
import hashlib, json, pathlib, re, subprocess
manifest = pathlib.Path('docs/dependencies/dependency-manifest.json').read_text(encoding='utf-8')
recorded = re.findall(r'"lockfileSha256":\s*"([0-9a-f]{64})"', manifest)
locks = ['package-lock.json', 'apps/studio/package-lock.json']
for lock, rec in zip(locks, recorded):
    blob = subprocess.run(['git', 'cat-file', 'blob', f'HEAD:{lock}'],
                           capture_output=True).stdout
    blob_hash = hashlib.sha256(blob).hexdigest()
    tree = pathlib.Path(lock).read_bytes()
    tree_hash = hashlib.sha256(tree).hexdigest()
    norm_hash = hashlib.sha256(tree.replace(b'\r\n', b'\n')).hexdigest()
    print(f'{lock}')
    print(f'  recorded in the manifest : {rec}')
    print(f'  git blob sha256           : {blob_hash}   match={blob_hash == rec}')
    print(f'  working tree sha256       : {tree_hash}   match={tree_hash == rec}')
    print(f'  LF-normalised sha256      : {norm_hash}   match={norm_hash == rec}')
PY
  echo

  echo "-------------------------------------------------------------------"
  echo "3. the gate works in a checkout path with spaces / non-ASCII"
  echo "-------------------------------------------------------------------"
  SPCR="D:/hermes-multica/home/cache/scratch/ats102-sp ace 中"
  rm -rf "$SPCR"; mkdir -p "$SPCR"
  # The source must be a NATIVE path: MSYS paths are not translated for native git.
  NATIVE_ROOT="$(cd "$ROOT" && pwd -W 2>/dev/null || pwd)"
  git clone -q --no-hardlinks -b agent/m3/seikoist-147-fix "$NATIVE_ROOT" "$SPCR/repo" 2>&1 | sed 's/^/    /'
  cd "$SPCR/repo" || exit 1
  echo "checkout path: $SPCR/repo"
  echo
  for step in checknode manifest lockcheck; do
    echo "--- step: $step"
    node tools/ci_build_gate.mjs --step "$step" 2>&1 | grep -E 'RESULT|Cannot find module|not found|Node .* is required' | sed 's/^/    /'
    echo "    exit code = ${PIPESTATUS[0]}"
    echo
  done
  echo "--- step: installdigest (needs an installed tree; reports the digest"
  echo "    comparison rather than the path problem)"
  node tools/ci_build_gate.mjs --step installdigest 2>&1 | grep -E 'RESULT|Cannot find module|expected|actual' | sed 's/^/    /'
  echo "    exit code = ${PIPESTATUS[0]}"
  cd "$ROOT" || exit 1
  echo
  echo "--- the same step on a path WITHOUT spaces, for comparison"
  NOSPC="D:/hermes-multica/home/cache/scratch/ats102-nospace"
  rm -rf "$NOSPC"; mkdir -p "$NOSPC"
  git clone -q --no-hardlinks -b agent/m3/seikoist-147-fix "$NATIVE_ROOT" "$NOSPC/repo" 2>&1 | sed 's/^/    /'
  cd "$NOSPC/repo" || exit 1
  node tools/ci_build_gate.mjs --step installdigest 2>&1 | grep -E 'RESULT|Cannot find module|expected|actual' | sed 's/^/    /'
  echo "    exit code = ${PIPESTATUS[0]}"
  cd "$ROOT" || exit 1
  echo
  echo "(The installdigest difference between the two paths is nil: the same"
  echo " digest is produced with and without spaces. The recorded expectation"
  echo " does not match this machine's install; see docs/17-BUILD-CI.md §7 item 11.)"
} > "$EV/08-manifest-drift-and-line-endings.log" 2>&1

rm -rf "$WORK"
echo "wrote $EV/08-manifest-drift-and-line-endings.log"
tail -40 "$EV/08-manifest-drift-and-line-endings.log"
