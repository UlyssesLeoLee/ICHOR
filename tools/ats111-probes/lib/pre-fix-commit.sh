#!/usr/bin/env bash
# ATS-111: the ONE definition of "the pre-fix tree".
#
# WHAT THIS SOLVES
# -----------------
# The evidence scripts used to pick the pre-fix tree with:
#
#     git log --oneline --all --grep='merge(ATS-111)' | head -1
#
# That is a DRIFTING selection: it asks git for "the most recent commit
# whose message mentions merge(ATS-111)". The moment the round-3 work
# is merged with a message that also matches, the selection moves FORWARD
# onto the FIXED tree -- and then the falsifiability step runs the new
# checks against the code they were written for, they all PASS, and the
# step reports "the new checks did NOT fail on the pre-fix tree -- they
# do not discriminate" while exiting 1.
#
# The round-2 review hit exactly that: after the merge, the documented
# re-run command selected the FIXED tree and the falsifiability step
# failed on a tree where nothing was broken. The evidence had been
# collected BEFORE the merge, so it could not be reproduced on the
# merged dev tip at all.
#
# THE FIX
# -------
# The pre-fix tree is a PINNED COMMIT ID, not a search:
#
#   ATS111_PREFIX_COMMIT   -- an explicit override (a full SHA);
#   the pinned default      -- the merge commit of the FIRST delivery,
#                             which is the tree the round-1 review
#                             rejected. That is the tree the new
#                             checks have to go RED on.
#
# The default is a constant, not a search, so it does not move when
# other commits are merged. The override exists for the case where a
# reviewer wants to point the step at a different tree.
#
# WHY THE FIRST DELIVERY IS THE RIGHT BASELINE
# --------------------------------------------
# The round-1 review rejected the tree at cb742ca, and the round-2
# review confirmed that the 16 view-level checks added afterwards DO go
# red on it. So cb742ca is the baseline that discriminates: it is the
# code before the four states were wired up and before the key
# commands were bound to the document.
#
# Usage:
#   source tools/ats111-probes/lib/pre-fix-commit.sh
#   PREFIX_COMMIT="$(ats111_prefix_commit)"
#   # or, in a script:
#   PREFIX_COMMIT="$(ats111_prefix_commit)"
set -u

# The merge commit of the FIRST delivery of ATS-111 -- the tree the
# round-1 review rejected, and the tree the view-level checks have to
# fail on.
ATS111_PREFIX_COMMIT_DEFAULT="cb742cad04a251e265726f5171af4c3c348ea37c"

# The name of the tree, for the log lines.
ATS111_PREFIX_TREE_LABEL="cb742ca"

# Print the commit to use as the pre-fix tree.
#
# The override wins when it is set AND it resolves to a commit that is
# actually IN this repository. An override that does not resolve is an
# error, not a silent fallback: a falsifiability step that quietly ran
# against a different tree than the reader asked for is worse than one
# that stops.
ats111_prefix_commit() {
  local override="${ATS111_PREFIX_COMMIT:-}"
  if [ -n "$override" ]; then
    if git cat-file -e "${override}^{commit}" 2>/dev/null; then
      printf '%s\n' "$(git rev-parse "$override")"
      return 0
    fi
    printf 'the ATS111_PREFIX_COMMIT override (%s) is not a commit in this repository\n' \
      "$override" >&2
    return 1
  fi
  if ! git cat-file -e "${ATS111_PREFIX_COMMIT_DEFAULT}^{commit}" 2>/dev/null; then
    printf 'the pinned pre-fix commit (%s) is not in this repository -- the history was rewritten\n' \
      "$ATS111_PREFIX_COMMIT_DEFAULT" >&2
    return 1
  fi
  git rev-parse "$ATS111_PREFIX_COMMIT_DEFAULT"
}

# The short label of the pre-fix tree, for the logs.
ats111_prefix_label() {
  printf '%s\n' "$ATS111_PREFIX_TREE_LABEL"
}
