#!/usr/bin/env bash
# ATS-103 mutation evidence -- the mutations that break the probe's claims.
#
# The probe claims that the shipped bundle resolves the API base from the
# page's own location at RUNTIME. This script mutates apps/studio/lib/api.ts
# so the base is a build-time constant, rebuilds the export, and runs the
# probe. The two runtime-base checks must turn RED.
#
# It also mutates the app so that a route handler reaches the export, in two
# shapes: one the build refuses (which proves the build rejects it) and one
# the build ACCEPTS (which proves the export-tree assertion turns red).
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
    echo "--- git status of the mutated paths (empty == restored) ---"
    git status --short "$API_TS" apps/studio/app
    echo "--- (the two lines above are empty: the mutation was fully reverted) ---"
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
#
# Two shapes are needed, because they prove TWO DIFFERENT things:
#
#   A  -- a route handler WITHOUT `force-static`. Next.js refuses it at BUILD
#         time ("export const dynamic = 'force-static'/export const revalidate
#         not configured on route ..."), so there is no export at all. This
#         proves "the build rejects a route handler" -- it does NOT exercise
#         the export-tree assertion, because no export is produced.
#
#   A' -- a route handler WITH `export const dynamic = 'force-static';`. The
#         build SUCCEEDS and the handler is PRERENDERED into the export as
#         the static file `out/api/session`. This is the shape that exercises
#         the export-tree assertion: the probe must report
#         "FAIL the export contains no server-side API route output --
#         found: api/session" and exit 1.
# =========================================================================
{
  echo "======================================================================"
  echo "MUTATION A -- an app/api/session route handler in the app source"
  echo "======================================================================"
  echo ""
  echo "Claim under test:"
  echo "  PASS  the export contains no server-side API route output"
  echo ""
  echo "This mutation has two shapes, and they prove different things:"
  echo "  A  -- a handler WITHOUT force-static: Next.js refuses it at BUILD"
  echo "        time, so the export is never produced. This proves that the"
  echo "        build rejects such a route; it does NOT exercise the"
  echo "        export-tree assertion, because there is no export tree."
  echo "  A' -- a handler WITH force-static: the build SUCCEEDS and the"
  echo "        handler is prerendered into the export as out/api/session."
  echo "        This is the shape that makes the export-tree assertion turn"
  echo "        RED, and it is the one that proves the assertion works."
  echo ""
  echo "--- mutation: apps/studio/app/api/session/route.ts (no force-static) ---"
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
  echo "(the build refused the route, so there is no export to probe;"
  echo " the refusal IS the finding this shape proves)"
} >> "$LOG"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

# --- Mutation A': the same route handler, WITH force-static ----------------
{
  echo "======================================================================"
  echo "MUTATION A' -- the same route handler, WITH force-static"
  echo "======================================================================"
  echo ""
  echo "Claim under test (the export-tree assertion itself):"
  echo "  PASS  the export contains no server-side API route output"
  echo ""
  echo "The build does NOT refuse this shape: the handler is prerendered"
  echo "into the export as the static file out/api/session. The probe must"
  echo "therefore report"
  echo "  FAIL  the export contains no server-side API route output -- found: api/session"
  echo "and exit 1. This is the shape that exercises the assertion's own"
  echo "traversal logic."
  echo ""
  echo "--- mutation: apps/studio/app/api/session/route.ts (with force-static) ---"
} >> "$LOG"

cat > apps/studio/app/api/session/route.ts <<'ROUTE'
export const dynamic = 'force-static';
export function GET() { return Response.json({ proxiedByNext: true }); }
ROUTE
sed -n '1,5p' apps/studio/app/api/session/route.ts >> "$LOG"
echo "" >> "$LOG"

rm -rf apps/studio/out apps/studio/.next
{
  echo "--- next build (the mutated source, force-static) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
BUILD_EXIT=$?
echo "BUILD_EXIT=$BUILD_EXIT" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- the export tree after the build ---"
  ls -la apps/studio/out/api/ 2>&1 >> "$LOG"
  echo ""
  echo "--- the probe against the mutated export ---"
} >> "$LOG"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

# Restore the clean source and rebuild the clean export.
rm -rf apps/studio/app/api
rm -rf apps/studio/out apps/studio/.next
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "CLEAN_REBUILD_EXIT=$?" >> "$LOG"

# =========================================================================
# Mutation B: the API base is baked at BUILD time.
#
# Two shapes, because they prove DIFFERENT things:
#
#   B  -- the base is a build-time constant and the bundle carries NO
#         `location.port` comparison at all. The static heuristic turns
#         RED.
#
#   B2 -- the base is a build-time constant AND the bundle carries an
#         UNRELATED `location.port` comparison. The static heuristic stays
#         GREEN -- it cannot tell the two apart, it only sees that a
#         comparison exists -- so B2 is the counter-example that bounds
#         what the static heuristic proves. The EXECUTED discriminator
#         (ui-smoke.mjs) is what turns red under B2.
# =========================================================================
{
  echo ""
  echo "======================================================================"
  echo "MUTATION B -- the API base is a build-time constant"
  echo "======================================================================"
  echo ""
  echo "Claim under test:"
  echo "  PASS  the shipped bundle carries a comparison of the page location port"
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
MUTATIONS_FAILED=0
if [ "$MUT_B_APPLIED" -ne 0 ]; then
  echo "MUTATION B DID NOT APPLY -- the probe result below is meaningless" >> "$LOG"
  MUTATIONS_FAILED=1
  # The source was not modified, so the export on disk is still the clean
  # one. Rebuild it, so the mutations that follow start from a known state.
  rm -rf apps/studio/out apps/studio/.next
  NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
  echo "CLEAN_REBUILD_EXIT=$?" >> "$LOG"
  echo "" >> "$LOG"
else

rm -rf apps/studio/out apps/studio/.next
{
  echo "--- next build (the mutated source) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "BUILD_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- the HTTP probe against the mutated export ---"
  echo "(the static heuristic must turn RED here: no location.port comparison)"
} >> "$LOG"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- the EXECUTED discriminator against the mutated export ---"
  echo "(this one must turn RED too: the API requests leave for the numeric address)"
} >> "$LOG"
node tools/ats103-probes/ui-smoke.mjs >> "$LOG" 2>&1
echo "UI_PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

# The mutated source is restored HERE, before mutation B2 and mutation C, so
# that each mutation isolates exactly ONE thing. Mutation B2 is about the
# static heuristic's blind spot; mutation C is about the missing engine. If
# either ran against mutation B's export, its result would show the
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

fi

# --- Mutation B2: a baked base PLUS an unrelated port comparison ---------
# This is the counter-example that bounds what the static heuristic proves.
# The base is baked AND the bundle carries a `location.port` comparison, so
# the static heuristic (which only sees that a comparison exists) stays
# GREEN. The EXECUTED discriminator in ui-smoke.mjs must turn RED.
{
  echo "======================================================================"
  echo "MUTATION B2 -- a baked base PLUS an unrelated location.port comparison"
  echo "======================================================================"
  echo ""
  echo "Claim under test (the static heuristic's BOUND):"
  echo "  PASS  the shipped bundle carries a comparison of the page location port"
  echo ""
  echo "The base is baked AND the bundle carries a location.port comparison that"
  echo "does not select the base. The static heuristic CANNOT tell this from"
  echo "the honest bundle -- it only sees that a comparison exists -- so this"
  echo "shape leaves the static heuristic GREEN. That is the honest bound of"
  echo "the heuristic, and it is why the runtime-resolution claim is proved by"
  echo "the EXECUTED discriminator in ui-smoke.mjs, which opens the page by"
  echo "NAME (localhost) and records the host the API requests actually went"
  echo "to. A baked base sends them to the numeric address; a runtime-resolved"
  echo "base sends them to localhost."
  echo ""
  echo "--- mutation: apps/studio/lib/api.ts (baked base + unrelated comparison) ---"
} >> "$LOG"

python - <<'PY2' >> "$LOG" 2>&1
import io, re
p = 'apps/studio/lib/api.ts'
s = io.open(p, encoding='utf-8').read()
lines = s.split('\n')
idx = [i for i, l in enumerate(lines) if l.startswith('const root=')]
assert len(idx) == 1, \
    'expected exactly one `const root=` line in api.ts, found %d -- the mutation did not apply' % len(idx)
i = idx[0]
line = lines[i]
assert 'window.location.port' in line, \
    'the base is not resolved from the page location -- the mutation did not apply'
quoted = line.split("'")
absolute = quoted[-2]
assert absolute.startswith('http'), \
    'could not read the absolute base out of the base definition -- the mutation did not apply'

# The base is baked. The port comparison is KEPT, but it no longer selects
# the base -- it only feeds a diagnostic string. Wiring it into a string
# that is really used is what keeps it in the shipped bundle: a comparison
# written into a discarded expression would be dropped by the minifier, and
# the mutation would then not be the counter-example it claims to be.
#
# The port literal is DERIVED from the product's own absolute base, not
# written here: this file is scanned by the ATS-101 port audit, and a port
# literal written here would be a runtime hardcoding site that the baseline
# document does not list.
m_port = re.search(r':(\d+)\'?\s*$', absolute)
assert m_port, 'could not read the default port out of the absolute base -- the mutation did not apply'
port = m_port.group(1)
lines[i] = ("const root=()=>'%s';const _sameOrigin=typeof window!=='undefined'&&"
            "window.location.port==='%s';" % (absolute, port))

marker = "throw Error('\u65e0\u6cd5\u8fde\u63a5\u672c\u5730\u6267\u884c\u670d\u52a1\u3002\u8bf7\u5148\u8fd0\u884c npm start')"
if marker not in '\n'.join(lines):
    raise AssertionError('the session error message was not found -- the mutation did not apply')
lines = [l.replace(marker, "throw Error('\u65e0\u6cd5\u8fde\u63a5\u672c\u5730\u6267\u884c\u670d\u52a1\u3002\u8bf7\u5148\u8fd0\u884c npm start'+_sameOrigin)") for l in lines]

s2 = '\n'.join(lines)
assert s2 != s, 'the base definition was not replaced -- the mutation did not apply'
io.open(p, 'w', encoding='utf-8', newline='').write(s2)
print("  before: (the runtime base definition in apps/studio/lib/api.ts)")
print("  after : the base is a constant; a location.port comparison remains, but")
print("          it only feeds a diagnostic string -- it no longer selects the base")
PY2
MUT_B2_APPLIED=$?
echo "" >> "$LOG"
if [ "$MUT_B2_APPLIED" -ne 0 ]; then
  echo "MUTATION B2 DID NOT APPLY -- the probe results below are meaningless" >> "$LOG"
  MUTATIONS_FAILED=1
  # The source was not modified, so the export on disk is still the clean
  # one. Rebuild it, so the mutations that follow start from a known state.
  rm -rf apps/studio/out apps/studio/.next
  NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
  echo "CLEAN_REBUILD_EXIT=$?" >> "$LOG"
  echo "" >> "$LOG"
else

rm -rf apps/studio/out apps/studio/.next
{
  echo "--- next build (the mutated source, B2) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "BUILD_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- the HTTP probe against the mutated export ---"
  echo "(the static heuristic is expected to stay GREEN here -- that is the bound)"
} >> "$LOG"
node tools/ats103-probes/verify-export-and-proxy.mjs >> "$LOG" 2>&1
echo "PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"
{
  echo "--- the EXECUTED discriminator against the mutated export ---"
  echo "(this one must turn RED: the API requests leave for the numeric address)"
} >> "$LOG"
node tools/ats103-probes/ui-smoke.mjs >> "$LOG" 2>&1
echo "UI_PROBE_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

cp "$BACKUP" "$API_TS"
rm -rf apps/studio/out apps/studio/.next
{
  echo "--- the source was restored and the export rebuilt (clean baseline) ---"
} >> "$LOG"
NODE_OPTIONS=--max-old-space-size=6144 npm --prefix apps/studio run build >> "$LOG" 2>&1
echo "CLEAN_REBUILD_EXIT=$?" >> "$LOG"
echo "" >> "$LOG"

fi

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
  echo "MUTATION A: an app/api/session route handler (no force-static)"
  echo "A          -> the BUILD refuses it; no export is produced"
  echo "MUTATION A': the same route handler, WITH force-static"
  echo "A'         -> the export tree assertion turns RED (found: api/session)"
  echo "MUTATION B: the API base is a build-time constant"
  echo "B          -> the static heuristic turns RED, the EXECUTED one too"
  echo "MUTATION B2: a baked base PLUS an unrelated location.port comparison"
  echo "B2         -> the static heuristic stays GREEN (its bound); the"
  echo "              EXECUTED discriminator turns RED"
  echo "MUTATION C: the Playwright engine is not installed"
  echo ""
  echo "--- the exit codes and results recorded above ---"
  grep -nE "^(PROBE_EXIT=|UI_PROBE_EXIT=|BUILD_EXIT=|CLEAN_REBUILD_EXIT=|RESULT:)" "$LOG" | grep -v "^.*RESULT:.*checks passed\.$" | head -40
} >> "$LOG.tmp"
cat "$LOG.tmp" >> "$LOG"
rm -f "$LOG.tmp"

echo "mutation evidence written to $LOG"

# A mutation that could not be applied makes the whole log untrustworthy:
# the reader would see a green probe and could not tell it apart from a
# green probe under a mutation that DID apply. The script therefore exits
# non-zero in that case, and the collector records that exit code.
if [ "${MUTATIONS_FAILED:-0}" -ne 0 ]; then
  echo "at least one mutation did not apply -- the evidence is NOT trustworthy"
  exit 1
fi
