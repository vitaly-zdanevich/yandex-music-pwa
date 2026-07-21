#!/usr/bin/env bash
# Securely provisions the Yandex Music token in SSM Parameter Store.
# The token is read silently from a terminal and sent to AWS over stdin; this
# script deliberately refuses token arguments so it cannot leak into history or
# a process listing.
set -euo pipefail

# Do not allow an accidental `bash -x` invocation to print the token when it is
# later passed from the shell variable to stdin.
if [[ $- == *x* ]]; then
  set +x
fi

umask 077

PROJECT_NAME="${PROJECT_NAME:-yandex-music-pwa-proxy}"
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
parameter_name="/$PROJECT_NAME/yandex-token"
token=""

cleanup() {
  token=""
  unset token
}
trap cleanup EXIT

if (( $# != 0 )); then
  echo "Usage: AWS_REGION=region PROJECT_NAME=name $0" >&2
  echo "The token must be entered at the silent prompt, never as an argument." >&2
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
  echo "A terminal is required for secure token entry." >&2
  exit 1
fi

printf 'Yandex Music token: ' >&2
if ! IFS= read -r -s token; then
  printf '\nToken entry was cancelled.\n' >&2
  exit 1
fi
printf '\n' >&2

if [[ -z "$token" ]]; then
  echo "The token cannot be empty." >&2
  exit 2
fi

# file:///dev/stdin keeps the secret out of the aws process command line.
export AWS_PAGER=""
printf '%s' "$token" | aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name "$parameter_name" \
  --type SecureString \
  --tier Standard \
  --overwrite \
  --value file:///dev/stdin \
  >/dev/null

echo "Stored $parameter_name as an SSM Standard SecureString in $AWS_REGION."
