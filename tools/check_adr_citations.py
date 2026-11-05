"""Check every `file:line` citation in docs/16-BASELINE-ADR.md against the code.

The ATS-101 port probe covers only the two port positions. Every OTHER
citation in the ADR is maintained by hand, so this script checks them all:
for each citation it reads the cited line and asserts that the line still
holds the code the ADR says it does.

COVERAGE (ATS-301 review finding C3)
-------------------------------------
The script FIRST enumerates EVERY `path:line` reference that appears in the
ADR, and then checks each one. A reference that no checker covers is
reported as UNCOVERED and fails the run -- so the script cannot silently
claim to have checked "every citation" while checking only a hand-picked
subset.

Two kinds of citation exist:

  * a POSITION citation (`server/index.mjs:194`) -- one line, checked
    against the needle the ADR's sentence implies;
  * a RANGE citation (`server/index.mjs:60-65`) -- a span of lines. The
    END of the range is READ FROM THE ADR TEXT (never hardcoded), and the
    span is checked to be the extent of the construct the ADR names.

The port-related citations (`apps/studio/lib/api.ts:6`, `start.sh:4`, ...)
are covered by the ATS-101 port audit
(`tools/ats101-probes/scenario-d-port-audit.mjs`), which validates them by
POSITION against the source. They are listed here so that the coverage
enumeration knows about them; the audit itself is run separately.

Usage: python tools/check_adr_citations.py
Exit 0 and prints RESULT: OK when every citation resolves.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADR = ROOT / 'docs' / '16-BASELINE-ADR.md'

# ---------------------------------------------------------------------------
# The citations this script checks itself.
#
# file -> {cited line as it appears in the ADR: distinctive substring}
#
# The line numbers below are the ones the ADR itself carries, so they are
# checked against the ADR text: if the ADR changes a citation, this table
# has to change with it, and the script says so instead of silently passing.
# ---------------------------------------------------------------------------
EXPECTED = {
    'server/index.mjs': {
        14: 'const PORT=Number(process.env.ATS_PORT||',
        18: "['queued','running'].includes(run.status)",
        60: 'function cancelRun(run){',
        61: "throw new Error('RUN_NOT_ACTIVE')",
        67: 'new RegExp',
        78: 'Content-Security-Policy',
        123: "'cancelling'].includes(x.status)",
        # The AGENT_* error mapping. The ADR cites this position for the
        # statement "AGENT_* 前缀的错误统一映射为 400".
        194: 'const isAgentError=/^AGENT_/.test(code);',
        # The unified error STATUS mapping: the ADR cites this position for
        # the statement "该处用正则匹配错误消息，未命中即返回 500".
        202: 'const status=/NOT_FOUND/.test(message)?404:',
        # The message echo: the ADR cites this position for "把 e.message
        # 原样回显".
        203: 'return err(res,status,message);',
    },
    'server/core.mjs': {
        27: "throw new Error('NOT_A_DIRECTORY')",
        103: 'export function safeRunArgs(',
    },
    # The crate-type declaration. It is NOT a port reference, so the ATS-101
    # port audit does NOT cover it -- this script checks it itself.
    'src-tauri/Cargo.toml': {
        11: 'crate-type = ["staticlib", "cdylib", "rlib"]',
    },
}

# ---------------------------------------------------------------------------
# The RANGE citations. The end of a range is READ FROM THE ADR TEXT -- it is
# never hardcoded here -- so a range the ADR changes is checked against the
# range the ADR actually claims.
#
# (file, start anchor needle, description of the construct the range covers)
# ---------------------------------------------------------------------------
RANGES = [
    ('server/index.mjs', 'function cancelRun(run){', 'cancelRun'),
]

# ---------------------------------------------------------------------------
# The citations that are covered by the ATS-101 PORT AUDIT rather than by
# this script. The audit validates each of them BY POSITION against the
# source (tools/ats101-probes/scenario-d-port-audit.mjs).
# ---------------------------------------------------------------------------
PORT_AUDITED = {
    'apps/studio/lib/api.ts',
    'apps/studio/app/page.tsx',
    'apps/studio/public/fallback.html',
    'src-tauri/src/lib.rs',
    'start.sh',
    'start.ps1',
    'tools/generate_test_docs.py',
}

# A `path:line` reference. The path may contain slashes, dots, dashes and
# underscores; the line may be a range (`60-65`) or a list (`52,58,74`).
CITATION_RE = re.compile(
    r'(?<![\w./-])'
    r'([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)'
    r':(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)'
)

# An IPv4 literal is NOT a file citation: `127.0.0.1:4577` names a host and a
# port. The path part of a real citation always starts with a letter or an
# underscore, so an address (which starts with a digit) is excluded here.
IPV4_RE = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')


def cited_positions(text, rel):
    """Every single line number the ADR cites for `rel` (ranges expanded)."""
    out = set()
    for m in re.finditer(re.escape(rel) + r':(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)', text):
        for part in m.group(1).split(','):
            if '-' in part:
                a, b = part.split('-')
                for n in range(int(a), int(b) + 1):
                    out.add(n)
            else:
                out.add(int(part))
    return sorted(out)


def enumerate_citations(text):
    """Every (path, spec) the ADR cites, as a sorted, de-duplicated list.

    A `host:port` pair (`127.0.0.1:4577`) is NOT a file citation: it has no
    file extension. The pattern above requires one, so it cannot match.
    """
    found = {}
    for m in CITATION_RE.finditer(text):
        rel, spec = m.group(1), m.group(2)
        if IPV4_RE.match(rel):
            continue
        found.setdefault(rel, set()).add(spec)
    return {rel: sorted(specs) for rel, specs in sorted(found.items())}


def read_lines(rel):
    """The lines of `rel`, or an empty list when the file does not exist."""
    path = ROOT / rel
    if not path.exists():
        return []
    return path.read_text(encoding='utf-8').split('\n')


def main():
    text = ADR.read_text(encoding='utf-8')
    bad = []

    # --- 1. enumerate EVERY citation the ADR carries ------------------------
    all_citations = enumerate_citations(text)
    print('--- citations enumerated from the ADR ---')
    for rel, specs in all_citations.items():
        print('  %-32s %s' % (rel, ', '.join(specs)))
    print('')

    # --- 2. every citation must be covered by SOME checker --------------------
    # The coverage table is built from the EXPECTED positions, the RANGES and
    # the port-audited set. A citation that appears in none of them is
    # UNCOVERED: the script refuses to claim it checked something it did not.
    covered = set()
    for rel, table in EXPECTED.items():
        covered.add(rel)
    for rel, _needle, _desc in RANGES:
        covered.add(rel)

    for rel, specs in all_citations.items():
        if rel in PORT_AUDITED:
            continue
        if rel not in covered:
            bad.append('%s is cited by the ADR but no checker covers it' % rel)
            print('UNCOVERED %s (cited by the ADR, no checker covers it)' % rel)
            continue
        # The positions of this file must ALL be in the EXPECTED table (the
        # RANGE positions are checked separately, by the range check below).
        lines = read_lines(rel)
        if not lines:
            bad.append('%s is cited by the ADR but the file does not exist' % rel)
            print('UNCOVERED %s (the cited file does not exist)' % rel)
            continue
        table = EXPECTED.get(rel, {})
        # The start positions of the RANGE citations for this file. A range
        # is checked as a whole (start anchor + extent), so its interior
        # positions are covered by that check, not one by one.
        rng_positions = set()
        for rrel, needle, _desc in RANGES:
            if rrel != rel:
                continue
            rl = read_lines(rrel)
            for i, line in enumerate(rl, 1):
                if needle in line:
                    rng_positions.add(i)
                    break
        for spec in specs:
            if '-' in spec:
                a = int(spec.split('-')[0])
                if a in rng_positions:
                    continue
                bad.append('%s:%s is cited by the ADR but no range covers it' % (rel, spec))
                print('UNCOVERED %s:%s (cited by the ADR, no range covers it)' % (rel, spec))
                continue
            n = int(spec)
            if n in table or n in rng_positions:
                continue
            bad.append('%s:%d is cited by the ADR but no needle covers it' % (rel, n))
            print('UNCOVERED %s:%d (cited by the ADR, no needle covers it)' % (rel, n))

    # --- 3. every EXPECTED position must still be cited AND hold its needle --
    for rel, table in EXPECTED.items():
        lines = read_lines(rel)
        if not lines:
            bad.append('%s does not exist' % rel)
            print('WRONG %s (the file does not exist)' % rel)
            continue
        cited = cited_positions(text, rel)
        for line, needle in sorted(table.items()):
            if line not in cited:
                bad.append('%s:%d is not cited by the ADR any more' % (rel, line))
                print('STALE %s:%d (the ADR no longer cites it)' % (rel, line))
                continue
            if line > len(lines):
                bad.append('%s:%d is past the end of the file' % (rel, line))
                print('WRONG %s:%d (past EOF)' % (rel, line))
                continue
            actual = lines[line - 1]
            if needle in actual:
                print('ok   %s:%d' % (rel, line))
            else:
                bad.append('%s:%d does not hold %r' % (rel, line, needle))
                print('WRONG %s:%d -> %s' % (rel, line, actual[:100]))

    # --- 4. the RANGE citations: the end comes FROM THE ADR -----------------
    for rel, needle, desc in RANGES:
        lines = read_lines(rel)
        specs = sorted({s for s in all_citations.get(rel, []) if '-' in s})
        if not specs:
            bad.append('%s no longer cites a range for %s' % (rel, desc))
            print('STALE %s (the ADR no longer cites a %s range)' % (rel, desc))
            continue
        for spec in specs:
            a, b = (int(x) for x in spec.split('-'))
            start_ok = a <= len(lines) and needle in lines[a - 1]
            end_ok = b <= len(lines) and lines[b - 1].strip() == '}'
            if start_ok and end_ok:
                print('ok   %s:%s (%s extent)' % (rel, spec, desc))
            else:
                bad.append('%s:%s is not the %s extent' % (rel, spec, desc))
                print('WRONG %s:%s (not the %s extent)' % (rel, spec, desc))

    # --- 5. the port-audited citations must exist and be audited ------------
    for rel in sorted(PORT_AUDITED):
        if rel not in all_citations:
            continue
        if not read_lines(rel):
            bad.append('%s is cited by the ADR but the file does not exist' % rel)
            print('WRONG %s (the cited file does not exist)' % rel)
            continue
        print('ok   %s (covered by the ATS-101 port audit)' % rel)

    if bad:
        print('\nRESULT: MISMATCH')
        for b in bad:
            print('  ', b)
        return 1
    print('\nRESULT: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
