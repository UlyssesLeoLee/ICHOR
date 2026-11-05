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

Two properties this generator guarantees:

  1. **Only tracked files are listed.** The file set comes from
     `git ls-files`; untracked files are never hashed. Probe and build
     artefacts (a probe-generated src-tauri/icons/icon.ico, a
     src-tauri/Cargo.lock produced by cargo) therefore never leak into the
     release manifest. The manifest describes the committed tree, so it must
     describe exactly that.

  2. **Every digest is the digest of the committed blob.** The bytes are read
     through `git cat-file blob HEAD:<path>`, and the working tree is checked
     against that blob first (via `git hash-object --path`, which applies
     git's own clean filter and therefore matches the blob exactly). A file
     that is not committed yet, or whose working tree drifted from the
     commit, stops the generator instead of producing a manifest that
     describes a tree nobody can check out.

Consequence for the workflow: commit the content first, then regenerate the
manifest, then commit the manifest.
"""
import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'CHECKSUMS.sha256'
EXCLUDE = {'CHECKSUMS.sha256', 'docs/WBS.xlsx', 'AGENTS.md'}
SKIP_DIRS = ('.multica/',)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    """Run a git command, returning stdout as bytes. Raises on failure."""
    return subprocess.run(
        ['git', '-C', str(ROOT), *args],
        capture_output=True, check=True,
    ).stdout


def git_text(*args):
    return git(*args).decode('utf-8')


def main():
    # tracked files only -- untracked artefacts must not enter the manifest
    tracked = [p for p in git_text('ls-files').split('\n') if p]

    paths = sorted({
        p for p in tracked
        if p and p not in EXCLUDE and not p.startswith(SKIP_DIRS)
    })

    lines = []
    for rel in paths:
        full = ROOT / rel
        if not full.is_file():
            raise SystemExit(f'{rel}: tracked by git but missing from the working tree')

        # git's own normalisation of the working tree, compared against the
        # committed blob: equal means the working tree matches the commit.
        worktree_hash = git_text('hash-object', '--path', rel, str(full)).strip()
        commit_hash = git_text('rev-parse', f'HEAD:{rel}').strip()
        if worktree_hash != commit_hash:
            raise SystemExit(
                f'{rel}: the working tree differs from the committed blob -- '
                f'commit the change before regenerating the manifest'
            )

        blob = git('cat-file', 'blob', f'HEAD:{rel}')
        lines.append(f'{sha256(blob)}  {rel}')

    # The manifest uses LF line terminators, so its bytes are the SAME on
    # every machine and in every checkout.
    #
    # This matters because the generator is also run on Windows with
    # core.autocrlf=true. Writing CRLF there would be a trap: git's clean
    # filter rewrites the file to LF when it is committed, so the blob is LF,
    # but the working tree keeps the CRLF bytes -- and on a machine with
    # core.autocrlf=false the working tree file would then differ from the
    # committed blob and the generator's own consistency check would refuse
    # to run. Writing LF makes the working tree file and the committed blob
    # identical under BOTH settings.
    #
    # The digest of each listed file is unaffected: it is the digest of that
    # file's blob, not of the manifest.
    lf = chr(10)
    MANIFEST.write_bytes((lf.join(lines) + lf).encode('utf-8'))
    print(f'{MANIFEST.name}: {len(lines)} entries')


if __name__ == '__main__':
    main()
