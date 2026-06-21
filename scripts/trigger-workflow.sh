#!/usr/bin/env bash
# Trigger a GitHub Actions workflow via API
# Usage: ./trigger-workflow.sh <workflow-file>
# Example: ./trigger-workflow.sh full_market_scan.yml
#
# Required env vars:
#   GH_TOKEN  — GitHub personal access token (needs Actions: write scope)

set -euo pipefail

OWNER="rekisss"
REPO="invest"
BRANCH="main"
WORKFLOW="${1:?Usage: $0 <workflow-file.yml>}"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "Error: GH_TOKEN is not set" >&2
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Triggering $WORKFLOW ..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$OWNER/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -d "{\"ref\":\"$BRANCH\"}")

if [[ "$HTTP_STATUS" == "204" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] OK — $WORKFLOW triggered"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAILED — HTTP $HTTP_STATUS" >&2
  exit 1
fi
