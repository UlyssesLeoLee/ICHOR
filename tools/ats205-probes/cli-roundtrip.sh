#!/usr/bin/env bash
# ATS-205 -- the CLI round trip, as a repeatable probe.
#
# The probe drives tools/sqlite_meta.mjs through its whole command set and
# prints what each command answered, so the evidence log is a transcript of
# a run rather than a hand-written description of one.
#
# Usage: bash tools/ats205-probes/cli-roundtrip.sh <work-dir>
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The work directory has to be a NATIVE path: the tool is a node program
# and node resolves a POSIX path (`/tmp/...`) against the CURRENT DRIVE of
# the shell, which is not where the shell wrote the file.
WORK="${1:-$(mktemp -d)}"
case "$WORK" in
  [A-Za-z]:*) ;;
  /*) WORK="C:$WORK" ;;
  *) WORK="$(pwd -W 2>/dev/null || pwd)/$WORK" ;;
esac
mkdir -p "$WORK"
DB="$WORK/metadata.db"
STATE="$WORK/state.json"

cd "$REPO"

cat > "$STATE" <<'JSON'
{
  "schema": 1,
  "projects": [
    { "id": "p1", "uid": "p1", "name": "a", "root": "/a", "addedAt": "2026-01-01T00:00:00Z" }
  ],
  "runs": [
    {
      "id": "r1", "uid": "r1", "seq": 1, "projectId": "p1", "projectUid": "p1",
      "status": "failed", "createdAt": "2026-01-01T00:00:01Z",
      "attempts": [
        { "uid": "a1", "testUid": "t1", "retry": 0, "status": "failed", "caseStatus": "unexpected", "duration": 5 }
      ],
      "artifacts": [
        { "file": "trace.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size": 10 }
      ]
    }
  ],
  "uidRegistry": {
    "version": 1,
    "projects": { "p1": { "entries": [ { "uid": "t1", "file": "tests/a.spec.ts", "title": "works", "bodyKey": "k" } ] } }
  },
  "runCounters": { "p1": 1 }
}
JSON

echo "=== CLI round trip (ATS-205) ==="
echo
echo "--- 1. status on a database that does not exist (read-only) ---"
node tools/sqlite_meta.mjs status --db "$DB" --state "$STATE"
echo "exit=$?"
if [ -f "$DB" ]; then echo "file exists after status: true"; else echo "file exists after status: false"; fi
echo
echo "--- 2. import ---"
node tools/sqlite_meta.mjs import --db "$DB" --state "$STATE"
echo "exit=$?"
echo
echo "--- 3. status ---"
node tools/sqlite_meta.mjs status --db "$DB" --state "$STATE"
echo
echo "--- 4. verify ---"
node tools/sqlite_meta.mjs verify --db "$DB" --state "$STATE"
echo "exit=$?"
echo
echo "--- 5. the CLI refuses an invalid --to (exit code 2, the database is untouched) ---"
for t in abc 99 -1 1.5; do
  out="$(node tools/sqlite_meta.mjs migrate --to "$t" --db "$DB" 2>&1)"
  code=$?
  echo "migrate --to $t : exit=$code | $(echo "$out" | tr '\n' ' ')"
done
out="$(node tools/sqlite_meta.mjs downgrade --to -1 --db "$DB" 2>&1)"
code=$?
echo "downgrade --to -1 : exit=$code | $(echo "$out" | tr '\n' ' ')"
echo
echo "--- 6. verify against a database that does not exist (read-only, creates nothing) ---"
out="$(node tools/sqlite_meta.mjs verify --db "$WORK/never-created.db" --state "$STATE" 2>&1)"
code=$?
echo "exit=$code | $(echo "$out" | tr '\n' ' ')"
if [ -f "$WORK/never-created.db" ]; then echo "file now exists: true"; else echo "file now exists: false"; fi
echo
echo "--- 7. downgrade to version 1 (explicit, lossy) ---"
node tools/sqlite_meta.mjs downgrade --to 1 --db "$DB"
echo "exit=$?"
node tools/sqlite_meta.mjs status --db "$DB" --state "$STATE"
echo
echo "--- 8. migrate back (forward-only, additive) ---"
node tools/sqlite_meta.mjs migrate --db "$DB"
echo
echo "--- 9. verify right after the round trip ---"
echo "The downgrade in step 7 was LOSSY by design: it dropped the v2 tables"
echo "(test_attempts, artifacts) WITH their data, and step 8 recreated the"
echo "tables EMPTY. The JSON state still holds those records, so the mirror"
echo "no longer matches -- and verifyMirror says so instead of hiding it."
node tools/sqlite_meta.mjs verify --db "$DB" --state "$STATE"
echo "exit=$?"
echo
echo "--- 10. re-import from the JSON state: the mirror catches up ---"
node tools/sqlite_meta.mjs import --db "$DB" --state "$STATE"
echo "exit=$?"
node tools/sqlite_meta.mjs verify --db "$DB" --state "$STATE"
echo "exit=$?"
echo
echo "--- 11. the JSON state file was never modified by any of it ---"
node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const j=JSON.parse(s);console.log('projects='+j.projects.length+' runs='+j.runs.length+' attempts='+j.runs[0].attempts.length+' artifacts='+j.runs[0].artifacts.length)" "$STATE"
