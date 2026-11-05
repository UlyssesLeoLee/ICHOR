#!/usr/bin/env python3
"""ATS-102 -- diff two installed dependency trees, file by file.

Both trees are installed from the SAME committed lockfile, so every
difference between them is attributable to the npm version that installed
them.

Usage:
    python tools/ats102-probes/diff-install-trees.py <tree-a> <tree-b>

Exit code 0 always: this is a reporting tool, not a gate.
"""
import hashlib
import os
import sys


def tree(root):
    """rel-path -> sha256, over every regular file under root."""
    out = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            h = hashlib.sha256()
            try:
                with open(full, 'rb') as fh:
                    for chunk in iter(lambda: fh.read(1 << 16), b''):
                        h.update(chunk)
            except OSError as exc:
                print(f'  UNREADABLE {rel}: {exc}')
                continue
            out[rel] = h.hexdigest()
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a_root, b_root = sys.argv[1], sys.argv[2]
    a = tree(a_root)
    b = tree(b_root)
    print(f'tree A : {a_root}  ({len(a)} files)')
    print(f'tree B : {b_root}  ({len(b)} files)')
    print('')

    only_a = sorted(set(a) - set(b))
    only_b = sorted(set(b) - set(a))
    common = set(a) & set(b)
    diff = sorted(p for p in common if a[p] != b[p])

    print(f'--- present in A only: {len(only_a)} files ---')
    for p in only_a:
        print(f'  + {p}')
    print('')
    print(f'--- present in B only: {len(only_b)} files ---')
    for p in only_b:
        print(f'  - {p}')
    print('')
    print(f'--- in both, different content: {len(diff)} files ---')
    for p in diff:
        print(f'  ~ {p}')
    print('')

    # The packages the difference belongs to: that is the level a reader needs.
    pkgs = {}
    for p in only_a + only_b + diff:
        if p.startswith('node_modules/'):
            pkgs.setdefault('/'.join(p.split('/')[:2]), 0)
            pkgs['/'.join(p.split('/')[:2])] += 1
    print('--- the packages the difference belongs to ---')
    for name, count in sorted(pkgs.items()):
        print(f'  {name}  ({count} file(s) differ)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
