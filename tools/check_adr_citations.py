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

The RUNTIME port citations (`apps/studio/lib/api.ts:6`, ...) are covered
by the ATS-101 port audit
(`tools/ats101-probes/scenario-d-port-audit.mjs`), which validates them by
POSITION against the source. That exemption is granted per POSITION, not per
FILE: the audit compares the runtime port occurrences of the tree against the
positions 16 §3.1 lists, and it says nothing about the other lines of the same
file. A citation of a different line of an audited file is therefore NOT
covered and has to carry a needle here.

The NON-runtime port citations (`start.sh:4`, `start.ps1:8-9`,
`tools/generate_test_docs.py:120,126,157`) are checked by this script: the
port audit only asserts that those FILES are listed, not that the listed
positions are the port-bearing ones.

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
        16: 'const PORT=Number(process.env.ATS_PORT||',
        42: "['queued','running'].includes(run.status)",
        97: 'function cancelRun(run){',
        98: "throw new Error('RUN_NOT_ACTIVE')",
        104: 'new RegExp',
        115: 'Content-Security-Policy',
        177: "'cancelling'].includes(x.status)",
        # The AGENT_* error mapping. The ADR cites this position for the
        # statement "AGENT_* 前缀的错误统一映射为 400".
        269: 'const isAgentError=/^AGENT_/.test(code);',
        # The unified error STATUS mapping: the ADR cites this position for
        # the statement "该处用正则匹配错误消息，未命中即返回 500".
        286: 'const status=/NOT_FOUND/.test(message)?404:',
        # The message echo: the ADR cites this position for "把 e.message
        # 原样回显".
        287: 'return err(res,status,message);',
    },
    'server/core.mjs': {
        230: "throw new Error('NOT_A_DIRECTORY')",
        323: 'export function safeRunArgs(',
    },
    # The crate-type declaration. It is NOT a port reference, so the ATS-101
    # port audit does NOT cover it -- this script checks it itself.
    'src-tauri/Cargo.toml': {
        11: 'crate-type = ["staticlib", "cdylib", "rlib"]',
    },
    # The NON-runtime port mentions. The ATS-101 port audit only asserts that
    # these FILES are listed in 16 §3.1; it does not validate the positions
    # inside them, so the positions are checked here.
    #
    # The needles deliberately stop BEFORE the port number. The port audit
    # scans every source file for the hardcoded port and classifies a hit as
    # a RUNTIME hardcoding site, so a needle that spelled the port out would
    # make this checker look like a runtime site and break that audit. The
    # needle still pins the line: it is the distinctive prefix of the URL
    # the line prints.
    'start.sh': {
        4: 'AI Test Studio: http://127.0.0.1:',
    },
    'start.ps1': {
        8: 'AI Test Studio -- local runner at http://127.0.0.1:',
        9: "Start-Process 'http://127.0.0.1:",
    },
    'tools/generate_test_docs.py': {
            203: "'localhost:3000 + ",
            209: "'Host=evil.example:",
            255: '同 LAN 他机尝试访问 ',
        },
        # The ATS-103 WBS updater mentions the port inside a NOTE TEXT (the
            # value never takes effect). The ADR cites it, so this script checks it.
            #
            # The needles deliberately do NOT contain the port literal: writing it
            # here would add a runtime port occurrence to this file, and the ATS-101
            # port audit would then report this file as a port-hardcoding site.
            'tools/update_wbs_ats103.py': {
                110: 'output:export 下的真实形态是导出页到 127.0.0.1:',
                114: 'staticFile() 以该目录为静态根',
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
#
# The exemption is PER POSITION, not per FILE. The audit compares the
# RUNTIME port occurrences of the tree against the positions 16 §3.1 lists;
# it says nothing about the other lines of an audited file, and it does not
# look at the NON-runtime files at all (it only asserts that those files are
# listed). So only the exact positions below are exempt -- a citation of any
# other line of the same file is reported as UNCOVERED.
#
# file -> {position: what the position is}
# ---------------------------------------------------------------------------
PORT_AUDITED = {
    # RUNTIME port hardcodings: the audit validates each of these positions
    # against the source.
    'apps/studio/lib/api.ts': {7: 'the API base URL'},
    'apps/studio/app/page.tsx': {81: 'the workbench footer text'},
    'apps/studio/public/fallback.html': {3: 'the portable UI footer text'},
    'src-tauri/src/lib.rs': {19: 'the ATS_PORT environment default'},
}

# A `path:line` reference. The path may contain slashes, dots, dashes and
# underscores; the line may be a range (`60-65`) or a list (`52,58,74`).
CITATION_RE = re.compile(
    r'(?<![\w./-])'
    r'([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)'
    r':(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)'
)

# An IPv4 literal is NOT a file citation: a `host:port` pair names a host and
# a port, not a file. The path part of a real citation always starts with a
# letter or an underscore, so an address (which starts with a digit) is
# excluded here.
#
# The port number is NOT written out as a literal in this file: the ATS-101
# port audit scans every source file for the hardcoded default port and
# classifies a hit as a RUNTIME hardcoding site. A literal here would make
# this checker look like a seventh runtime site and break the port audit.
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

    A `host:port` pair is NOT a file citation: it has no file extension.
    The pattern above requires one, so it cannot match.
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


def expand_spec(spec):
    """The individual line numbers a citation spec names.

    A spec is a single line (`14`), a range (`60-65`) or a comma-separated
    list of either (`52,58,74`). The list form is expanded into its members
    here, so every later step works on one line number at a time.

    A malformed spec is reported, not raised: the caller turns it into an
    UNCOVERED entry with a readable diagnostic instead of a traceback.
    """
    out = []
    for part in spec.split(','):
        part = part.strip()
        if not part:
            raise ValueError('the list has an empty entry')
        if '-' in part:
            bounds = part.split('-')
            if len(bounds) != 2:
                raise ValueError('the range %r has more than one dash' % part)
            a, b = (int(x) for x in bounds)
            if b < a:
                raise ValueError('the range %r runs backwards' % part)
            out.extend(range(a, b + 1))
        else:
            out.append(int(part))
    return out


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
    # the port-audited POSITIONS. A citation that appears in none of them is
    # UNCOVERED: the script refuses to claim it checked something it did not.
    covered = set()
    for rel, table in EXPECTED.items():
        covered.add(rel)
    for rel, _needle, _desc in RANGES:
        covered.add(rel)

    for rel, specs in all_citations.items():
        # The port audit exempts POSITIONS, not files: a file is only exempt
        # at the positions the audit actually validates. Every other position
        # of the same file has to carry a needle here.
        port_positions = set(PORT_AUDITED.get(rel, {}))
        if rel in covered:
            pass
        elif not port_positions:
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
            # A malformed spec is a diagnostic, not a traceback: the run
            # fails closed, but with a message that names the offending spec.
            try:
                members = expand_spec(spec)
            except ValueError as exc:
                bad.append('%s:%s is a malformed citation spec: %s' % (rel, spec, exc))
                print('UNCOVERED %s:%s (malformed citation spec: %s)' % (rel, spec, exc))
                continue
            # A RANGE is checked as a whole below; its members are covered by
            # that check, so only a range whose START is not a range anchor
            # is reported here. A range whose members each carry their own
            # needle is covered too -- the needles are checked one by one in
            # step 3.
            if '-' in spec:
                a = members[0]
                if a in rng_positions:
                    continue
                if all(n in table for n in members):
                    continue
                bad.append('%s:%s is cited by the ADR but no range covers it' % (rel, spec))
                print('UNCOVERED %s:%s (cited by the ADR, no range covers it)' % (rel, spec))
                continue
            for n in members:
                if n in table or n in rng_positions:
                    continue
                if n in port_positions:
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
    # The exemption is per POSITION, so this checks that each exempted
    # position is actually cited by the ADR (a position the audit validates
    # but the ADR does not mention would make the audit's guarantee vacuous)
    # and that the cited file exists.
    for rel in sorted(PORT_AUDITED):
        if rel not in all_citations:
            bad.append('%s is port-audited but the ADR does not cite it' % rel)
            print('STALE %s (port-audited but not cited by the ADR)' % rel)
            continue
        if not read_lines(rel):
            bad.append('%s is cited by the ADR but the file does not exist' % rel)
            print('WRONG %s (the cited file does not exist)' % rel)
            continue
        cited = set(cited_positions(text, rel))
        for position, what in sorted(PORT_AUDITED[rel].items()):
            if position not in cited:
                bad.append('%s:%d is port-audited but the ADR does not cite it' % (rel, position))
                print('STALE %s:%d (port-audited but not cited by the ADR)' % (rel, position))
                continue
            print('ok   %s:%d (%s -- covered by the ATS-101 port audit)' % (rel, position, what))

    if bad:
        print('\nRESULT: MISMATCH')
        for b in bad:
            print('  ', b)
        return 1
    print('\nRESULT: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
