#!/usr/bin/env bash
# Prints the Rust proxy's CloudWatch logs. Works with AWS CLI v1 and v2.
#
#   ./scripts/show-logs.sh              # last hour
#   SINCE=3d ./scripts/show-logs.sh     # last three days
#   FOLLOW=1 ./scripts/show-logs.sh     # keep polling for new events
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-yandex-music-pwa-proxy}"
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
SINCE="${SINCE:-1h}"

if [[ -z "$AWS_REGION" ]]; then
  echo "AWS_REGION is required (or set a default region in AWS CLI config)." >&2
  exit 1
fi

if [[ ! "$SINCE" =~ ^([1-9][0-9]*)([smhd])$ ]]; then
  echo "SINCE must look like 45s, 30m, 12h or 3d" >&2
  exit 2
fi
amount="${BASH_REMATCH[1]}"
case "${BASH_REMATCH[2]}" in
  s) seconds="$amount" ;;
  m) seconds=$((amount * 60)) ;;
  h) seconds=$((amount * 3600)) ;;
  d) seconds=$((amount * 86400)) ;;
esac

start_ms=$((($(date +%s) - seconds) * 1000))

show_since() {
  aws logs filter-log-events \
    --region "$AWS_REGION" \
    --log-group-name "/aws/lambda/$PROJECT_NAME" \
    --start-time "$1" \
    --query 'events[].message' \
    --output text
}

if [[ "${FOLLOW:-}" == "1" ]] && aws --version 2>&1 | grep -q '^aws-cli/2\.'; then
  exec aws logs tail "/aws/lambda/$PROJECT_NAME" \
    --region "$AWS_REGION" \
    --since "$SINCE" \
    --follow \
    --format short
elif [[ "${FOLLOW:-}" == "1" ]]; then
  echo "AWS CLI v1 fallback may repeat a few late-arriving events; CLI v2 has native follow mode." >&2
  while true; do
    now_ms=$(($(date +%s) * 1000))
    show_since "$start_ms"
    start_ms=$((now_ms - 10000))
    sleep 5
  done
else
  show_since "$start_ms"
fi
