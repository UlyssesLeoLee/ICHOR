#!/usr/bin/env bash
# ATS-103 mutation evidence -- mutation B: the API base is baked at BUILD time.
#
# The probe claims that the shipped bundle resolves the API base from the
# page's own location at RUNTIME. This script mutates apps/studio/lib/api.ts
# so the base is a build-time constant, rebuilds the export, and runs the
# probe. The two runtime-base checks must turn RED.
#
# The source is restored and the export rebuilt at the end, so the tree is
# left exactly as it was found.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

OUT="$ROOT/docs/evidence/ATS-103"
mkdir -p "$OUT"
# The log path is overridable so that a caller (the evidence collector) can
# have the script write somewhere else and then assemble the final file.
# Without this, a collector that redirects our stdout and then cats the
# pieces together would overwrite the log this script writes.
LOG="${ATS103_MUTATION_LOG:-$OUT/06-mutation-evidence.log}"
COMMIT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

API_TS="apps/studio/lib/api.ts"
# The backup lives OUTSIDE the repository, in the scratch directory. A backup
# inside the working tree would show up as an untracked file and could be
# committed by accident; here it cannot be seen by git at all.
BACKUP="${TMPDIR:-/tmp}/ats103-api.ts.bak.$$"

cp "$API_TS" "$BACKUP"
restore() {
  cp "$BACKUP" "$API_TS"
  rm -f "$BACKUP"
  rm -rf apps/studio/app/api
  NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build > /dev/null 2>&1
  {
    echo ""
    echo "--- the source tree and the export were restored ---"
    git status --short "$API_TS" apps/studio/app
  } >> "$LOG"
}
trap restore EXIT

{
  echo "=== ATS-103 evidence: mutation evidence ==="
  echo "date      : $STAMP (UTC)"
  echo "commit    : $COMMIT"
  echo "node      : $(node --version)"
  echo "npm       : $(npm --version)"
  echo ""
  echo "Each mutation below breaks ONE claim the probe makes. The probe's"
  echo "corresponding check must turn RED (FAIL) and the probe must exit 1."
  echo "A mutation that leaves the probe green means the check was vacuous."
  echo ""
} > "$LOG"

# =========================================================================
# Mutation A: an app/api/** route handler reaches the export.
# =========================================================================
{
  echo "======================================================================"
  echo "MUTATION A -- an app/api/session route handler in the app source"
  echo "======================================================================"
  echo ""
  echo "Claim under test:"
  echo "  PASS  the export contains no server-side API route output"
  echo ""
  echo "--- mutation: apps/studio/app/api/session/route.ts ---"
} >> "$LOG"

mkdir -p apps/studio/app/api/session
cat > apps/studio/app/api/session/route.ts <<'ROUTE'
export function GET() { return Response.json({ proxiedByNext: true }); }
ROUTE
sed -n '1,5p' apps/studio/app/api/session/route.ts >> "$LOG"
echo "" >> "$LOG"

rm -rf apps/studio/out apps/studio/.next
{
  echo "--- next build (the mutated source) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
BUILD_EXIT=$?
echo "BUILD_EXIT=$BUILD_EXIT" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- what the build said about the route under output: 'export' ---"
  grep -E "output: export|Error|api/session" "$LOG" | tail -8 >> "$LOG"
  echo ""
  echo "--- the export tree after the build ---"
  ls -la apps/studio/out/api/ 2>&1 >> "$LOG"
  echo ""
  echo "--- the probe against the mutated export ---"
} >> "$LOG"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

# The build refuses the route, so there is no export to probe; that refusal
# IS the finding. Record it explicitly, then rebuild the clean export.
rm -rf apps/studio/app/api
rm -rf apps/studio/out apps/studio/.next
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "CLEAN_REBUILD_EXIT=$?" >> "$LOG"

# =========================================================================
# Mutation B: the API base is baked at BUILD time.
# =========================================================================
{
  echo ""
  echo "======================================================================"
  echo "MUTATION B -- the API base is a build-time constant"
  echo "======================================================================"
  echo ""
  echo "Claims under test:"
  echo "  PASS  the shipped bundle resolves the API base from the page location at runtime"
  echo "  PASS  the shipped bundle does NOT bake the API base at build time"
  echo ""
  echo "--- mutation: apps/studio/lib/api.ts ---"
} >> "$LOG"

# The mutated expression is DERIVED from the product source, not written
# here: the script finds the `root` definition in apps/studio/lib/api.ts and
# rewrites it so the base becomes a constant. Writing the literal here
# would (a) duplicate a port literal the ATS-101 port audit has to count and
# (b) silently stop matching if the product's base expression changes --
# which would make this mutation a no-op and the evidence worthless.
#
# The rewrite is done by locating the `const root=` LINE and rebuilding it,
# not by matching it with a regular expression: the line contains `()`, and
# in a regex `()` is an empty group, so a pattern written by hand silently
# expects a different string and never matches.
python - <<'PY' >> "$LOG" 2>&1
import io
p = 'apps/studio/lib/api.ts'
s = io.open(p, encoding='utf-8').read()
lines = s.split('\n')

# Locate the base definition. There must be exactly one.
idx = [i for i, l in enumerate(lines) if l.startswith('const root=')]
assert len(idx) == 1, \
    'expected exactly one `const root=` line in api.ts, found %d -- the mutation did not apply' % len(idx)
i = idx[0]
line = lines[i]

# The runtime form resolves the base from the page's own port. Assert that
# before mutating: if the product no longer has that shape, this mutation
# is meaningless and the script must fail rather than pretend.
assert 'window.location.port' in line, \
    'the base is not resolved from the page location -- the mutation did not apply'

# The absolute base is the last single-quoted string on the line.
quoted = line.split("'")
absolute = quoted[-2]
assert absolute.startswith('http'), \
    'could not read the absolute base out of the base definition -- the mutation did not apply'

lines[i] = "const root=()=>'%s';" % absolute
s2 = '\n'.join(lines)
assert s2 != s, 'the base definition was not replaced -- the mutation did not apply'
io.open(p, 'w', encoding='utf-8', newline='').write(s2)
print("  before: (the runtime base definition in apps/studio/lib/api.ts)")
print("  after : const root=()=>'%s';" % absolute)
PY
MUT_B_APPLIED=$?
echo "" >> "$LOG"
if [ "$MUT_B_APPLIED" -ne 0 ]; then
  echo "MUTATION B DID NOT APPLY -- the probe result below is meaningless" >> "$LOG"
  exit 1
fi

rm -rf apps/studio/out apps/studio/.next
{
  echo "--- next build (the mutated source) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "BUILD_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- the probe against the mutated export ---"
} >> "$LOG"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"

# The mutated source is restored HERE, before mutation C, so that each
# mutation isolates exactly ONE thing. Mutation C is about the missing
# engine; if it ran against mutation B's export, its result would show the
# base-resolution checks red too, and the log would not say which mutation
# broke what.
cp "$BACKUP" "$API_TS"
rm -rf apps/studio/out apps/studio/.next
{
  echo ""
  echo "--- the source was restored and the export rebuilt (clean baseline) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "CLEAN_REBUILD_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

# =========================================================================
# Mutation C: the Playwright engine is not installed.
# =========================================================================
{
  echo ""
  echo "======================================================================"
  echo "MUTATION C -- the Playwright engine is not installed"
  echo "======================================================================"
  echo ""
  echo "Claim under test:"
  echo "  PASS  the accepted run reaches a passed/failed terminal state"
  echo "  PASS  the terminal run reports a per-case result set"
  echo "  PASS  the terminal run summary matches the on-disk report.json"
  echo "  PASS  the terminal run collected artefacts"
  echo ""
  echo "--- mutation: examples/sample-playwright/node_modules is moved away ---"
} >> "$LOG"

FIXTURE_NM="examples/sample-playwright/node_modules"
# The stash lives OUTSIDE the repository: a stashed dependency tree inside
# the working tree would show up as an untracked path and could be
# committed by accident.
STASH="${TMPDIR:-/tmp}/ats103-fixture-node_modules.$$"
mv "$FIXTURE_NM" "$STASH"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"
mv "$STASH" "$FIXTURE_NM"
echo "" >> "$LOG"
echo "--- the fixture dependencies were restored ---" >> "$LOG"

{
  echo ""
  echo "======================================================================"
  echo "SUMMARY -- every mutation must leave the probe red (exit 1)"
  echo "======================================================================"
  echo ""
  echo "MUTATION A: an app/api/session route handler"
  echo "MUTATION B: the API base is a build-time constant"
  echo "MUTATION C: the Playwright engine is not installed"
  echo ""
  echo "--- the exit codes and results recorded above ---"
  grep -nE "^(PROBE_EXIT=|BUILD_EXIT=|CLEAN_REBUILD_EXIT=|RESULT:)" "$LOG" | grep -v "^.*RESULT:.*checks passed\.$" | head -40
} >> "$LOG.tmp"
cat "$LOG.tmp" >> "$LOG"
rm -f "$LOG.tmp"

echo "mutation evidence written to $LOG"
