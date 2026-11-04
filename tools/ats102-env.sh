#!/usr/bin/env bash
# ATS-102 -- environment for running the build gate with Node 22 on this host.
#
# The gate spawns native Windows processes (npm.cmd -> cmd.exe), and cmd.exe
# resolves `node` from the PATH in its Windows form. An MSYS-style PATH
# (/d/...) is not translated for native children, so both forms must be on the
# PATH. This script sets that up and puts the shell's PATH back to a sane
# length -- repeated `export PATH=...:$PATH` calls in one session can push it
# past the Windows environment limit, which silently breaks child processes.
#
# Usage:  source tools/ats102-env.sh   (then: node tools/ci_build_gate.mjs)

NODE22_DIR="${ATS_NODE22_DIR:-/d/hermes-multica/home/cache/scratch/node22/node-v22.23.4-win-x64}"

# A short, explicit PATH: MSYS tools first, then Node 22, then the Windows
# system directories that native children need.
#
# Every path here is in MSYS form (/c/..., /d/...): bash needs that form to
# find the binary, and MSYS translates the whole PATH into Windows form when
# it spawns a native child, so `npm.cmd` -> `cmd.exe` still resolves `node`.
# The Windows form ("C:/Windows/system32") must NOT be used here: MSYS reads
# the leading "C:" as a relative path and rewrites it to
# "C:\Program Files\Git\Windows\system32", where taskkill.exe does not exist.
# That silently breaks the product's Windows stop path (spawn taskkill ENOENT),
# which then fails the cancel test.
#
# Repeated `export PATH=...:$PATH` calls in one session can push PATH past the
# Windows environment limit, which silently breaks child processes -- hence
# the short, explicit PATH here.
PATH="/usr/bin:/bin:/mingw64/bin:$NODE22_DIR:/c/Windows/system32:/c/Windows:/c/Windows/System32/Wbem:/c/Windows/System32/WindowsPowerShell/v1.0:/c/Program Files/nodejs"
export PATH

# npm must resolve packages from the canonical registry so the committed
# lockfiles (whose `resolved` URLs point at registry.npmjs.org) match.
export npm_config_registry="${npm_config_registry:-https://registry.npmjs.org/}"

node --version
npm --version
