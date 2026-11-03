#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo 'AI Test Studio: http://127.0.0.1:4577/fallback.html'
node server/index.mjs
