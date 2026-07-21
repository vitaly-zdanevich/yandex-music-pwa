#!/usr/bin/env bash
# Removes the operator-managed Yandex Music token from SSM Parameter Store.
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-yandex-music-pwa-proxy}"
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
parameter_name="/$PROJECT_NAME/yandex-token"

if (( $# != 0 )); then
  echo "Usage: AWS_REGION=region PROJECT_NAME=name $0" >&2
  exit 64
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "Missing required command: aws" >&2
  exit 1
fi

if [[ -z "$AWS_REGION" ]]; then
  echo "AWS_REGION is required (or set a default region in AWS CLI config)." >&2
  exit 1
fi

if [[ ! "$PROJECT_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "PROJECT_NAME may contain only letters, digits, dots, underscores and hyphens." >&2
  exit 2
fi

if [[ ! -t 0 ]]; then
  echo "A terminal is required to confirm token removal." >&2
  exit 1
fi

printf 'Remove %s from SSM in %s? [y/N] ' "$parameter_name" "$AWS_REGION" >&2
IFS= read -r answer
if [[ ! "$answer" =~ ^[Yy]$ ]]; then
  echo "Token was not removed."
  exit 0
fi

export AWS_PAGER=""
aws ssm delete-parameter \
  --region "$AWS_REGION" \
  --name "$parameter_name" \
  >/dev/null

echo "Removed $parameter_name from SSM in $AWS_REGION."
