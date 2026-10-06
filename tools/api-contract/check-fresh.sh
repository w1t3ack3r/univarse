#!/usr/bin/env sh
# Spec 0011 OA9: regenerate the contract files from the code and fail if the committed ones differ.
# CI runs this after the build; locally: sh tools/api-contract/check-fresh.sh
set -eu
FILES="packages/api-client/openapi.json packages/api-client/src/schema.ts"
pnpm contracts:gen
# --porcelain also catches a generated file that was never committed (untracked) or was deleted.
if [ -n "$(git status --porcelain -- $FILES)" ]; then
  git --no-pager diff --stat -- $FILES
  git status --short -- $FILES
  echo "::error title=Stale API contract files::The generated contract files differ from the committed ones. Run: pnpm contracts:gen, then commit packages/api-client/openapi.json and packages/api-client/src/schema.ts."
  exit 1
fi
echo "API contract files are fresh: openapi.json and schema.ts match the code."
