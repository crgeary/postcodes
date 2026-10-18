#!/usr/bin/env bash
# Review check from PLAN.md: nothing in index-format may be async. The hot path
# must never await, and the package must stay usable synchronously by the service.
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -rnE '\basync\b|\bawait\b|\bPromise\b' packages/index-format/src; then
  echo "error: async/await/Promise found in packages/index-format/src" >&2
  exit 1
fi
echo "ok: packages/index-format/src is synchronous"
