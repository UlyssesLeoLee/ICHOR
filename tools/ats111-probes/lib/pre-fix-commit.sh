#!/usr/bin/env bash
# ATS-111: the definitions of the "pre-fix trees" and of the checks that
# must fail on them.
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
# WHY THERE ARE TWO BASELINES
# ---------------------------
# The review rounds rejected two different deliveries, and the checks
# that prove this round's work discriminate against DIFFERENT trees:
#
#   BASELINE A -- cb742ca, the merge commit of the FIRST delivery. The
#   round-1 review rejected it: the four states were not wired up, the
#   key commands were bound to the app shell instead of the document,
#   the retry issued no request, the catalogue was not cleared on a
#   project switch, and there was no no-project state.
#
#   BASELINE B -- 9e305e7, the merge commit of the SECOND delivery. The
#   round-2 review rejected it for two narrower reasons: Escape did not
#   stop a running test, and Ctrl+P inside the open dialog leaked to
#   the browser. BOTH of those are REGRESSIONS OR OMISSIONS THAT ONLY
#   EXIST IN B -- the first delivery had no dialog guard at all, so the
#   Ctrl+P check PASSES on A.
#
# So a single baseline cannot decide the whole thing: a check that
# discriminates against B may legitimately pass on A. Each check is
# therefore bound to the baseline it has to fail on, and the step
# verifies each binding separately.
#
# Both baselines are PINNED COMMIT IDS, never searches, so they do not
# move when other commits are merged.
#
# Usage:
#   . tools/ats111-probes/lib/pre-fix-commit.sh
#   COMMIT="$(ats111_baseline_commit A)"
#   IDS="$(ats111_required_fail_ids A)"
set -u

# BASELINE A: the merge commit of the FIRST delivery of ATS-111 -- the
# tree the round-1 review rejected.
ATS111_BASELINE_A="cb742cad04a251e265726f5171af4c3c348ea37c"
ATS111_BASELINE_A_LABEL="cb742ca"

# BASELINE B: the merge commit of the SECOND delivery of ATS-111 -- the
# tree the round-2 review rejected.
ATS111_BASELINE_B="9e305e7552122eecb25fd05f02e1fb1b48cd07f5"
ATS111_BASELINE_B_LABEL="9e305e7"

# The checks that must FAIL on BASELINE A.
#
# These are the checks that prove the round-1 defects were real: the
# four states were not wired up, the retry was a no-op, the catalogue
# was not cleared, the key commands were bound to a container, and
# there was no no-project state.
#
# ST-111-11c is deliberately NOT here. On baseline A, pressing Enter on
# 「取消」 submits the form -- the dialog then CLOSES (the project is
# registered) -- so 11c passes and 11d fails. The defect is the
# WRITTEN ACTION, and 11d is the check that sees it.
ATS111_REQUIRED_FAIL_A="ST-111-10b ST-111-10e ST-111-10g ST-111-11d \
ST-111-12a ST-111-12d ST-111-13b ST-111-13c ST-111-13d \
ST-111-14b ST-111-14d"

# The checks that must FAIL on BASELINE B.
#
# These are the round-2 findings: Escape did not stop the run, and
# Ctrl+P inside the open dialog was not consumed. ST-111-16c/16d and
# ST-111-17b are the ones that carry them.
ATS111_REQUIRED_FAIL_B="ST-111-16c ST-111-16d ST-111-17b"

# The commit of a baseline. 'A' or 'B'.
#
# The override names a BASELINE, not a commit: `ATS111_BASELINE_A`
# overrides baseline A, `ATS111_BASELINE_B` overrides baseline B.
ats111_baseline_commit() {
  local which="${1:-A}"
  local pinned
  case "$which" in
    A) pinned="$ATS111_BASELINE_A" ;;
    B) pinned="$ATS111_BASELINE_B" ;;
    *) printf 'unknown baseline %s (expected A or B)\n' "$which" >&2; return 1 ;;
  esac
  local override_var="ATS111_BASELINE_${which}"
  local override="${!override_var:-}"
  if [ -n "$override" ]; then
    if git cat-file -e "${override}^{commit}" 2>/dev/null; then
      git rev-parse "$override"
      return 0
    fi
    printf 'the %s override (%s) is not a commit in this repository\n' \
      "$override_var" "$override" >&2
    return 1
  fi
  if ! git cat-file -e "${pinned}^{commit}" 2>/dev/null; then
    printf 'the pinned baseline %s (%s) is not in this repository -- the history was rewritten\n' \
      "$which" "$pinned" >&2
    return 1
  fi
  git rev-parse "$pinned"
}

# The short label of a baseline, for the logs.
ats111_baseline_label() {
  case "${1:-A}" in
    A) printf '%s\n' "$ATS111_BASELINE_A_LABEL" ;;
    B) printf '%s\n' "$ATS111_BASELINE_B_LABEL" ;;
    *) printf 'unknown\n' ;;
  esac
}

# The check ids that must FAIL on a baseline.
ats111_required_fail_ids() {
  case "${1:-A}" in
    A) printf '%s\n' "$ATS111_REQUIRED_FAIL_A" ;;
    B) printf '%s\n' "$ATS111_REQUIRED_FAIL_B" ;;
    *) printf '\n' ;;
  esac
}

# The legacy entry point: the FIRST delivery's tree. It is what the
# step used to select, and it is kept so that an existing caller keeps
# working -- but the step itself now checks BOTH baselines.
ats111_prefix_commit() {
  ats111_baseline_commit A
}

ats111_prefix_label() {
  ats111_baseline_label A
}
