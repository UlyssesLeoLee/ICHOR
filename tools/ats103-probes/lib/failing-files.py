"""List the test files that own the failing cases in a `node --test` log.

A parallel `npm test` boots one Bridge per test file. Under load a file can
miss its ready() window: the setup case reports "server did not boot" and
every case in that file is reported as failed along with it. The failure set
therefore varies from run to run, and `dev` fails the same way on its own.

This helper turns the log into the list of files to re-run, so the collector
can distinguish load-induced failures from real ones WITHOUT hardcoding case
names: every failing case must live in a file that passes on its own.

Usage:
    python tools/ats103-probes/lib/failing-files.py <npm-test.log>

Prints the space-separated file names, one per test file. Prints nothing when
no failing case carries a location (an unknown shape is never treated as
"load-induced").
"""
import re
import sys

LOCATION = re.compile(r"location: '([^']+\.test\.mjs):\d+:\d+'")


def failing_files(log_text):
    """Return the sorted test paths that own at least one failing case.

    The paths are relative to the repository root (`tests/<name>.test.mjs`)
    because that is what `node --test` accepts: a bare file name is not
    resolvable from the repository root and the runner answers
    "Could not find '<name>'".
    """
    files = set()
    for block in re.split(r'\nnot ok ', log_text)[1:]:
        match = LOCATION.search(block)
        if not match:
            # A failure without a location cannot be attributed to a file, so
            # it must not be swept up by the load-induced allowance.
            continue
        path = match.group(1).replace('\\', '/')
        files.add(path[path.rfind('/') + 1:])
    return sorted('tests/' + name for name in files)


def main(argv):
    if len(argv) != 2:
        print((__doc__ or '').strip(), file=sys.stderr)
        return 2
    with open(argv[1], encoding='utf-8', errors='replace') as handle:
        print(' '.join(failing_files(handle.read())))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
