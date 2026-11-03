"""ATS-101: regenerate CHECKSUMS.sha256 so the release manifest stays accurate.

Rule reproduced from the committed manifest (validated by regenerating it and
diffing against the original before touching the file):
  * one line per project file, `<sha256><2 spaces><path>`
  * plain ASCII sort by path
  * the manifest itself, docs/WBS.xlsx, AGENTS.md and .multica/ are excluded
  * the hashed bytes are the **git blob** content, i.e. the working-tree file
    after git's autocrlf clean filter (CRLF -> LF for text files, raw bytes
    for binary files). With core.autocrlf=true on Windows, hashing the raw
    working tree instead would produce a different digest for every text file.
"""
import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'CHECKSUMS.sha256'
EXCLUDE = {'CHECKSUMS.sha256', 'docs/WBS.xlsx', 'AGENTS.md'}
SKIP_DIRS = ('.multica/',)


def is_binary(data):
    """Git's heuristic: a NUL byte in the first 8000 bytes means binary."""
    return b'\x00' in data[:8000]


def clean_bytes(data):
    """Apply git's autocrlf=true clean filter to a working-tree file."""
    if is_binary(data):
        return data
    return data.replace(b'\r\n', b'\n')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.run(
        ['git', '-C', str(ROOT), *args],
        capture_output=True, text=True, check=True,
    ).stdout.split('\n')


def main():
    tracked = [p for p in git('ls-files') if p]
    untracked = [p for p in git('ls-files', '--others', '--exclude-standard') if p]

    paths = sorted({
        p for p in tracked + untracked
        if p and p not in EXCLUDE and not p.startswith(SKIP_DIRS)
    })

    lines = []
    for rel in paths:
        full = ROOT / rel
        if not full.is_file():
            continue
        lines.append(f'{sha256(clean_bytes(full.read_bytes()))}  {rel}')

    # the manifest itself uses CRLF line terminators
    MANIFEST.write_bytes(('\r\n'.join(lines) + '\r\n').encode('utf-8'))
    print(f'{MANIFEST.name}: {len(lines)} entries')


if __name__ == '__main__':
    main()
