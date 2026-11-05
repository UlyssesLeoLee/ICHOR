"""Independent CHECKSUMS.sha256 verification against git blob contents.

The generator (tools/update_checksums.py) is not trusted here: this script
recomputes every digest from `git cat-file blob HEAD:<path>` and checks that
the manifest lists exactly the tracked files (minus the documented exclusions).

Usage: python tools/verify_checksums.py
Exit 0 and prints RESULT: OK when the manifest matches the committed tree.
"""
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'CHECKSUMS.sha256'

EXCLUDE = {'CHECKSUMS.sha256', 'docs/WBS.xlsx', 'AGENTS.md'}
SKIP_PREFIXES = ('.multica/',)


def read_manifest():
    entries = {}
    raw = MANIFEST.read_bytes()
    for line in raw.split(b'\r\n'):
        if not line.strip():
            continue
        parts = line.split(b'  ', 1)
        if len(parts) != 2:
            print('BAD LINE:', line)
            sys.exit(1)
        entries[parts[1].decode('utf-8')] = parts[0].decode('ascii')
    return entries


def blob_digest(path):
    out = subprocess.run(['git', 'cat-file', 'blob', 'HEAD:' + path],
                         capture_output=True, cwd=str(ROOT))
    if out.returncode != 0:
        return None
    return hashlib.sha256(out.stdout).hexdigest()


def tracked_files():
    out = subprocess.run(['git', 'ls-files'], capture_output=True, text=True, cwd=str(ROOT))
    return out.stdout.split('\n')


def main():
    manifest = read_manifest()

    mismatches = []
    for path, digest in sorted(manifest.items()):
        actual = blob_digest(path)
        if actual is None:
            mismatches.append((path, 'no blob at HEAD'))
        elif actual != digest:
            mismatches.append((path, f'{digest} != {actual}'))

    tracked = [f for f in tracked_files() if f]
    expected = {f for f in tracked
                if f not in EXCLUDE
                and not f.startswith(SKIP_PREFIXES)}

    missing = sorted(expected - set(manifest))
    extra = sorted(set(manifest) - expected)

    print(f'manifest entries : {len(manifest)}')
    print(f'digest mismatches: {len(mismatches)}')
    for path, why in mismatches[:10]:
        print('   ', path, why)
    print(f'tracked-not-listed: {len(missing)} {missing[:5]}')
    print(f'listed-not-tracked: {len(extra)} {extra[:5]}')

    if mismatches or missing or extra:
        print('RESULT: MISMATCH')
        return 1
    print('RESULT: OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
