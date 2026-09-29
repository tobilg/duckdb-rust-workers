#!/usr/bin/env bash
# Recreate all local validation evidence, including after artifacts/ is deleted.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$PROJECT_ROOT"
mkdir -p artifacts/logs

./scripts/build-worker.sh 2>&1 | tee artifacts/logs/build.txt
./scripts/test-local.sh 2>&1 | tee artifacts/logs/test-local.txt
npx --no-install wrangler deploy --dry-run --outdir artifacts/wrangler 2>&1 | tee artifacts/logs/packaging.txt
npx --no-install wrangler check startup --outfile artifacts/startup.cpuprofile 2>&1 | tee artifacts/logs/startup-profile.txt
./scripts/measure.sh
./scripts/verify-artifact.sh
./scripts/validation-report.py
