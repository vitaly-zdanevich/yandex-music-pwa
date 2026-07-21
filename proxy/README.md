# Yandex Music proxy

Native `provided.al2023` Lambda HTTP proxy. The `bootstrap` binary uses
`lambda_http::run_with_streaming_response`, so media and API responses are not
buffered in Lambda memory. When `AWS_LAMBDA_RUNTIME_API` is absent it serves the
same routes on `HTTP_SERVER_ADDR` (default `127.0.0.1:8080`).

## Configuration

Production secrets are SSM `SecureString` parameters. The Lambda role has
read-only `ssm:GetParameter` access to the token and signing-key parameters. If
a customer-managed KMS key is used, grant the corresponding decrypt permission
as well.

| Variable | Purpose |
| --- | --- |
| `TOKEN_PARAMETER` | Yandex OAuth token SecureString path |
| `SIGNING_KEY_PARAMETER` | `get-file-info` HMAC key SecureString path |
| `ALLOWED_ORIGIN` | exact PWA origin allowed by CORS, for example `https://owner.github.io` |
| `PUBLIC_BASE_URL` | optional public Function URL used in resolved stream fallback URLs |
| `ORIGIN_VERIFY` | optional value required in the `X-Origin-Verify` header |
| `SECRET_CACHE_TTL_SECONDS` | decrypted in-memory cache lifetime, default 300 seconds |

For local development, omit the corresponding `*_PARAMETER` and use
`YANDEX_MUSIC_TOKEN` and `SIGNING_KEY`. The proxy only reads secrets; it never
writes or deletes them.

`ORIGIN_VERIFY` is intended only for a trusted server-to-server caller. Do not
set it for the browser PWA: an HTML audio element cannot attach that custom
header to its range requests, and Preferences does not persist a proxy secret.

When `ALLOWED_ORIGIN` is set, every `/api/*` request must carry that exact
`Origin`; missing and mismatched origins are rejected. Set `crossorigin="anonymous"`
on the online audio element so iOS sends `Origin` on fallback media requests.
This is browser-origin hardening, not an unforgeable client authentication
scheme; keep the personal Function URL private where practical.

## Settings contract

- `GET /api/settings/status` returns `{"configured":true|false}`.

Provision or replace the token operator-side with `scripts/set-token.sh`; there
is no browser-accessible token-management endpoint. The proxy validates the
stored token before use and never logs it. All Yandex API and media-resolution
calls use the server-side token; browser `Authorization` headers are ignored.

`GET /api/media/resolve/:id` requests Yandex's highest quality with both FLAC
containers first, followed by AAC, HE-AAC, and MP3 variants, and returns `codec`, `bitrate`,
`quality`, and `url`. It also returns a short-lived `directUrl` when the CDN
payload is unencrypted. Yandex's lossless payloads may be AES-CTR encrypted; in
that case `directUrl` is omitted and `url` resolves and decrypts the stream
inside Lambda without putting the decryption key in a query string. The Lambda
fallback seeks the cipher to each requested byte offset and preserves `206`,
`Content-Range`, and other range headers required by iOS. Every audio fallback
contains only a track ID, so it re-resolves an expired CDN URL before streaming.
Legacy resolution falls back to the highest-bitrate supported format. The
separate artwork fallback accepts only known Yandex avatar hosts and paths,
requires an image MIME type, follows only revalidated artwork redirects, and
buffers at most 5 MB. Track streaming no longer accepts arbitrary source URLs.

## Build and test

```sh
cargo test --manifest-path proxy/Cargo.toml
cargo lambda build --release --arm64 --manifest-path proxy/Cargo.toml --bin bootstrap
```

For Neoverse N1 tuning, set `RUSTFLAGS="-C target-cpu=neoverse-n1"` in the
native arm64 build environment.
