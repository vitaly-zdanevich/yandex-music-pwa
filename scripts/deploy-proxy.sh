#!/usr/bin/env bash
# Builds the Rust proxy for AWS Lambda Graviton (Neoverse N1) and deploys it.
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY_DIR="$PROJECT_ROOT/proxy"
TOOLS_DIR="$PROJECT_ROOT/.tools"
BUILD_ROOT="${BUILD_ROOT:-$PROJECT_ROOT/.build/$(id -un)}"
BUILD_DIR="$BUILD_ROOT/rust-lambda"
ZIP_PATH="$BUILD_ROOT/rust-lambda.zip"
TERRAFORM_DIR="$PROJECT_ROOT/infra/terraform"
ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$BUILD_ROOT/zig-global-cache}"
ZIG_LOCAL_CACHE_DIR="${ZIG_LOCAL_CACHE_DIR:-$BUILD_ROOT/zig-local-cache}"

AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
PROJECT_NAME="${PROJECT_NAME:-yandex-music-pwa-proxy}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://vitaly-zdanevich.github.io}"
LAMBDA_MEMORY_SIZE="${LAMBDA_MEMORY_SIZE:-256}"
RESERVED_CONCURRENCY="${RESERVED_CONCURRENCY:-auto}"
RUST_TARGET_CPU="${RUST_TARGET_CPU:-neoverse-n1}"
PACKAGE_ONLY="${PACKAGE_ONLY:-}"
readonly CARGO_LAMBDA_VERSION="1.9.1"
readonly RUST_TOOLCHAIN_VERSION="1.94.1"
rust_target="aarch64-unknown-linux-gnu"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

if [[ -z "$AWS_REGION" && "$PACKAGE_ONLY" != "1" ]]; then
  echo "AWS_REGION is required (or configure a default AWS CLI region)." >&2
  exit 1
fi

require_command curl
require_command zip

export PATH="$TOOLS_DIR/bin:$PATH"
export ZIG_GLOBAL_CACHE_DIR ZIG_LOCAL_CACHE_DIR
mkdir -p "$TOOLS_DIR" "$BUILD_DIR" "$ZIG_GLOBAL_CACHE_DIR" "$ZIG_LOCAL_CACHE_DIR"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64) rustup_host="x86_64-unknown-linux-gnu" ;;
  Linux:aarch64 | Linux:arm64) rustup_host="aarch64-unknown-linux-gnu" ;;
  Darwin:x86_64) rustup_host="x86_64-apple-darwin" ;;
  Darwin:aarch64 | Darwin:arm64) rustup_host="aarch64-apple-darwin" ;;
  *)
    echo "Unsupported deploy host: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

rustup_bin="$TOOLS_DIR/bin/rustup"
if [[ ! -x "$rustup_bin" ]]; then
  rustup_init="$TOOLS_DIR/rustup-init"
  rustup_url="https://static.rust-lang.org/rustup/dist/$rustup_host/rustup-init"
  echo "Installing project-local Rust $RUST_TOOLCHAIN_VERSION"
  curl --proto '=https' --tlsv1.2 -fsSLo "$rustup_init" "$rustup_url"
  expected_checksum="$(curl --proto '=https' --tlsv1.2 -fsSL "$rustup_url.sha256")"
  expected_checksum="${expected_checksum%% *}"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_checksum="$(sha256sum "$rustup_init")"
    actual_checksum="${actual_checksum%% *}"
  elif command -v shasum >/dev/null 2>&1; then
    actual_checksum="$(shasum -a 256 "$rustup_init")"
    actual_checksum="${actual_checksum%% *}"
  else
    echo "Missing required checksum command: sha256sum or shasum" >&2
    exit 1
  fi
  if [[ -z "$expected_checksum" || "$actual_checksum" != "$expected_checksum" ]]; then
    rm -f "$rustup_init"
    echo "rustup-init checksum verification failed" >&2
    exit 1
  fi
  chmod +x "$rustup_init"
  RUSTUP_HOME="$TOOLS_DIR/rustup" CARGO_HOME="$TOOLS_DIR" \
    "$rustup_init" -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN_VERSION"
fi

export RUSTUP_HOME="$TOOLS_DIR/rustup"
export CARGO_HOME="$TOOLS_DIR"
export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN_VERSION"

if ! "$rustup_bin" run "$RUST_TOOLCHAIN_VERSION" rustc --version >/dev/null 2>&1; then
  "$rustup_bin" toolchain install "$RUST_TOOLCHAIN_VERSION" --profile minimal
fi

require_command cargo

if ! "$rustup_bin" target list --installed --toolchain "$RUST_TOOLCHAIN_VERSION" | grep -qx "$rust_target"; then
  "$rustup_bin" target add --toolchain "$RUST_TOOLCHAIN_VERSION" "$rust_target"
fi

cargo_lambda_bin="$TOOLS_DIR/bin/cargo-lambda"
cargo_lambda_version="$("$cargo_lambda_bin" lambda --version 2>/dev/null || true)"
read -r _ installed_cargo_lambda_version _ <<< "$cargo_lambda_version"
if [[ "${installed_cargo_lambda_version:-}" != "$CARGO_LAMBDA_VERSION" ]]; then
  echo "Installing project-local cargo-lambda $CARGO_LAMBDA_VERSION"
  cargo install cargo-lambda --version "$CARGO_LAMBDA_VERSION" --locked --root "$TOOLS_DIR"
fi

current_rustflags="${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS:-}"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS="${current_rustflags:+$current_rustflags }-C target-cpu=$RUST_TARGET_CPU"

echo "Building aarch64 Lambda bootstrap with target-cpu=$RUST_TARGET_CPU"
rm -rf "$PROXY_DIR/target/lambda/bootstrap" "$BUILD_DIR"
rm -f "$ZIP_PATH"
mkdir -p "$BUILD_DIR" "$(dirname "$ZIP_PATH")"
(
  cd "$PROXY_DIR"
  cargo lambda build --release --locked --bin bootstrap --arm64
)

bootstrap_path="$PROXY_DIR/target/lambda/bootstrap/bootstrap"
if [[ ! -x "$bootstrap_path" ]]; then
  echo "Expected Lambda bootstrap was not produced: $bootstrap_path" >&2
  exit 1
fi

cp "$bootstrap_path" "$BUILD_DIR/bootstrap"
chmod +x "$BUILD_DIR/bootstrap"
touch -t 198001010000 "$BUILD_DIR/bootstrap"
(
  cd "$BUILD_DIR"
  zip -Xq "$ZIP_PATH" bootstrap
)

if [[ "$PACKAGE_ONLY" == "1" ]]; then
  echo "Package built: $ZIP_PATH"
  exit 0
fi

require_command aws
require_command terraform

if [[ "$RESERVED_CONCURRENCY" == "auto" ]]; then
  read -r account_concurrency unreserved_concurrency <<< "$(aws lambda get-account-settings \
    --region "$AWS_REGION" \
    --query 'AccountLimit.[ConcurrentExecutions,UnreservedConcurrentExecutions]' \
    --output text)"
  if [[ ! "$account_concurrency" =~ ^[0-9]+$ || ! "$unreserved_concurrency" =~ ^[0-9]+$ ]]; then
    echo "Could not determine the Lambda account concurrency limit." >&2
    exit 1
  fi
  minimum_unreserved=100
  if (( account_concurrency < minimum_unreserved )); then
    minimum_unreserved=$account_concurrency
  fi
  if (( unreserved_concurrency >= minimum_unreserved + 2 )); then
    RESERVED_CONCURRENCY=2
  else
    RESERVED_CONCURRENCY=-1
    echo "Lambda has only $unreserved_concurrency unreserved executions; using account-level concurrency instead of a per-function reservation."
  fi
fi

terraform -chdir="$TERRAFORM_DIR" init -reconfigure
terraform -chdir="$TERRAFORM_DIR" apply -auto-approve \
  -var "aws_region=$AWS_REGION" \
  -var "project_name=$PROJECT_NAME" \
  -var "lambda_zip_path=$ZIP_PATH" \
  -var "lambda_memory_size=$LAMBDA_MEMORY_SIZE" \
  -var "reserved_concurrency=$RESERVED_CONCURRENCY" \
  -var "allowed_origin=$ALLOWED_ORIGIN"

echo "Function URL: $(terraform -chdir="$TERRAFORM_DIR" output -raw function_url)"
printf 'Provision the Yandex token privately with:\n  AWS_REGION=%q PROJECT_NAME=%q %q\n' \
  "$AWS_REGION" "$PROJECT_NAME" "$PROJECT_ROOT/scripts/set-token.sh"
