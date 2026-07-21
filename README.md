# My Wave for Yandex Music

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=coverage)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=bugs)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Duplicated Lines](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Maintainability](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Reliability](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Security](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=ncloc)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)
[![Technical Debt](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_yandex-music-pwa&metric=sqale_index)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_yandex-music-pwa)

A small, installable Yandex Music client focused on one job: playing personal recommendations quickly, including on an older iPhone. The web app is framework-free TypeScript, targets Safari on iOS 15, and is minified for production.

This is an unofficial client. It is not affiliated with Yandex and uses private, undocumented Yandex Music endpoints that can change without notice.

## What is included

- My Wave recommendations with previous/next controls, full-width artwork, artist, album, title, highest-quality codec, bitrate, and file size
- Like and dislike actions, plus a liked-tracks screen that hydrates at most 100 tracks per page
- Current-track audio download, native Yandex Music link sharing, Yandex, Genius, Last.fm, Wikipedia, YouTube, and Google links, plus track/album/artist searches on MusicBrainz and Wikidata
- A configurable rolling foreground cache of upcoming recommendations and their artwork (10 by default, 0–50)
- An Offline screen with playback, exact stored-byte usage, per-track removal, and remove-all
- A full-width Preferences screen that reports the proxy connection state, current version, and last 10 commits without ever accepting, transmitting, or storing a Yandex OAuth token
- A casual-use client gate that starts the player only for an iPhone on iOS 15, or Firefox on Linux at an exact 1200×1920 screen; this is a deterrent, not authentication
- Light and dark appearances via `prefers-color-scheme`; the dark document background is exactly `#000`
- iOS home-screen icons, service-worker app-shell caching, Media Session controls, and an iOS 15 build target
- A native Rust Lambda proxy, ARM64/Neoverse N1 deployment, Terraform, deployment/log scripts, tests, and GitHub Actions CI

There is intentionally no React, Vue, or virtual DOM. Direct DOM updates, a small dependency set, and a minified Safari 15 bundle reduce JavaScript parsing, memory use, and main-thread work on older phones.

## Architecture

```text
GitHub Pages                         AWS                              Yandex
┌────────────────────┐       ┌─────────────────────┐       ┌───────────────────┐
│ TypeScript PWA     │──────▶│ Lambda Function URL│──────▶│ private Music API │
│                    │ API   │ native Rust/arm64   │       └───────────────────┘
│ IndexedDB          │       │                     │
│ audio + artwork    │       │ resolves a signed  │       ┌───────────────────┐
└─────────┬──────────┘       │ short-lived URL    │──────▶│ Yandex media CDN  │
          │                  └──────────┬──────────┘       └─────────▲─────────┘
          └──── plaintext playback: direct signed CDN URL ─────────┘
                                      │
                                      └── range/CORS fallback and lossless decryption

                               SSM Parameter Store
                            OAuth token, signing key
```

CloudFront is not involved. The static app can live on GitHub Pages for free and calls a Lambda Function URL directly. CORS is restricted to the exact configured PWA origin. The Lambda additionally accepts `/api/*` only from an iPhone-on-iOS-15 user agent or Firefox on Linux; `/healthz` stays open. Screen dimensions are unavailable to Lambda, so the exact 1200×1920 Firefox check runs in the PWA before its service worker, application, or API client starts.

For a plaintext track, `GET /api/media/resolve/:id` returns a short-lived `directUrl` and a Lambda `url` fallback. Playback and offline caching try the Yandex CDN URL first. If browser CORS prevents a download, the native fallback forwards it without buffering the full track in Lambda memory.

Yandex can encrypt its highest-quality response. Safari cannot play those CDN bytes directly, so in that case `directUrl` is deliberately omitted: the Lambda URL re-resolves the track, decrypts AES-CTR incrementally, and seeks the cipher correctly for byte-range requests. Highest quality therefore takes precedence over bypassing AWS.

### Audio quality

Resolution is lossless-first: the proxy requests both FLAC containers before AAC, HE-AAC, and MP3 variants from the highest tier available to the account. If the current file-info route is unavailable, the legacy fallback orders non-preview sources by bitrate and takes the best supported one. The proxy does not transcode or deliberately reduce bitrate. Actual availability still depends on the subscription, catalog item, region, and formats returned by Yandex.

## Requirements

For the web app:

- Node.js 20 or newer and npm
- A Yandex Music account with permission to play full tracks

For local proxy work or AWS deployment:

- Rust and Cargo for local proxy development (the proxy currently declares Rust 1.94.1)
- `curl` and `zip`; the deploy script bootstraps a project-local Rust toolchain when `rustup` is unavailable
- AWS CLI credentials and Terraform 1.6 or newer
- Permission to create Lambda, IAM, CloudWatch Logs, SSM Parameter Store, Function URL, and optional AWS Budget resources

The deployment script installs the pinned `cargo-lambda` version under `.tools/` if it is not already available.

## Local development

Install the web dependencies:

```sh
npm ci
```

Vite forwards `/api` to the Rust server's default port, 8080. Start the proxy in one terminal; the silent prompt keeps the token out of shell history:

```sh
read -r -s -p 'Yandex Music token: ' YANDEX_MUSIC_TOKEN
printf '\n'
export YANDEX_MUSIC_TOKEN
export SIGNING_KEY='your file-info signing key'
npm run dev:proxy
unset YANDEX_MUSIC_TOKEN
```

Then start Vite in another terminal:

```sh
npm run dev:web
```

Open `http://localhost:5173`. The token exists only in the local Rust process environment until that process stops; Vite and browser code never receive it. The local and production proxies are read-only with respect to credentials, and the PWA has no endpoint that can write or delete a token. The combined `npm run dev` command remains available for convenience, but it necessarily gives both child processes the same environment.

When changing `HTTP_SERVER_ADDR`, update the target in `vite.config.ts` to match.

## Tests and production builds

```sh
npm test                 # Vitest and Rust tests
npm run test:web:coverage # TypeScript LCOV in coverage/lcov.info
npm run typecheck        # browser and Vite TypeScript projects
npm run build            # typecheck, minify, and emit dist/
npm run build:proxy      # native release build for the current machine
```

CI also checks Rust formatting and Clippy, performs an ARM64 release check with `target-cpu=neoverse-n1`, validates Terraform, runs the browser tests, and creates a production web build. Every push to `main` deploys that build to GitHub Pages only after all three CI jobs pass. The separate Sonar workflow generates TypeScript and Rust LCOV reports before scanning both source trees. See `.github/workflows/ci.yml` and `.github/workflows/build.yml`.

The Vite production configuration targets Safari 15, minifies JavaScript and CSS, omits source maps, and generates the app-shell service worker.

### Versioning

Every commit must increment the stable SemVer in `package.json`: use a minor increment for a feature and a patch increment for a fix or maintenance change. Keep `package-lock.json`, `proxy/Cargo.toml`, and `proxy/Cargo.lock` on the same version. `npm run check:version` validates the working tree locally. CI validates every commit in the pushed or pull-request range against its parent and also requires a pull-request result to exceed the current base-branch version.

Preferences displays the built-in current version and loads the latest 10 GitHub commits with the version recorded in each commit. That history is cached in `sessionStorage` for 10 minutes; the current version remains available when GitHub or the network is unavailable.

## Store the Yandex token in AWS

Use Systems Manager Parameter Store, not Secrets Manager. Standard parameters and standard-throughput Parameter Store API calls have no additional charge. The script uses the default AWS-managed KMS key, which has no key-storage fee; KMS requests have a separate 20,000-request monthly free tier and can be billed above it. Secrets Manager charges per secret and API use outside any account credits, so it is deliberately not part of this stack.

From a private terminal, store the token before (or after) the Lambda deployment. The script prompts without echoing the value:

```sh
AWS_REGION=eu-central-1 \
PROJECT_NAME=yandex-music-pwa-proxy \
./scripts/set-token.sh
```

The script writes directly through the AWS CLI to:

```text
/<project-name>/yandex-token
```

The token never passes through browser JavaScript, Terraform input, Terraform state, source files, or a Lambda HTTP endpoint. The Lambda role can only read this parameter. Rerun the script to rotate the token, or delete it with the matching operator-side command:

```sh
AWS_REGION=eu-central-1 \
PROJECT_NAME=yandex-music-pwa-proxy \
./scripts/remove-token.sh
```

Warm Lambda instances cache decrypted parameters for up to five minutes, so a rotation or deletion can take that long to be observed everywhere. A newly created, previously missing token is read immediately. See the official <https://aws.amazon.com/systems-manager/pricing/> and <https://aws.amazon.com/kms/pricing/> pages for current pricing.

## Deploy the AWS proxy

The deployment is deliberately CloudFront-free. It builds a native `aarch64-unknown-linux-gnu` Lambda bootstrap, tunes it for AWS Graviton's Neoverse N1 CPU, packages it for the `provided.al2023` runtime, and applies Terraform:

```sh
AWS_REGION=eu-central-1 \
ALLOWED_ORIGIN=https://your-user.github.io \
PROJECT_NAME=yandex-music-pwa-proxy \
./scripts/deploy-proxy.sh
```

`ALLOWED_ORIGIN` is an origin only: do not append the repository path or a trailing slash. The deploy script reserves two Lambda executions only when the AWS-reported quota can retain the account's required unreserved pool. For small accounts whose total quota is only 10, it automatically uses unreserved concurrency, so the account quota is the effective ceiling. Set `RESERVED_CONCURRENCY` explicitly to override that choice. CloudWatch logs are retained for one day.

To build the deployable ZIP without changing AWS:

```sh
PACKAGE_ONLY=1 ./scripts/deploy-proxy.sh
```

An optional $1 monthly AWS Budget can be created by setting a Terraform variable. Its current notification threshold is 10%, so it emails after AWS records roughly $0.10 of actual monthly cost; it is an alert, not a spending cap:

```sh
TF_VAR_budget_alert_email=you@example.com \
AWS_REGION=eu-central-1 \
ALLOWED_ORIGIN=https://your-user.github.io \
./scripts/deploy-proxy.sh
```

After deployment, retain the Function URL:

```sh
terraform -chdir=infra/terraform output -raw function_url
```

Terraform creates only the signing-key Standard parameter; its configured value is present in local Terraform state even though the SSM value is a `SecureString`. The OAuth token is provisioned out of band and never enters that state. To avoid adding a paid state service, this project deliberately uses local Terraform state and its filesystem lock. It creates neither S3 nor DynamoDB. DynamoDB would only be useful later as shared locking for a remote state backend; this single-operator deployment does not need it. The deploy script uses a restrictive umask, and state/build files are ignored by Git; keep that local state file private and backed up securely.

Because Terraform does not own the token parameter, `terraform destroy` cannot remove it. Run `scripts/remove-token.sh` when you want to delete it.

## Publish the PWA on GitHub Pages

Every push to `main` runs the complete CI matrix and then publishes the PWA to:

<https://vitaly-zdanevich.github.io/yandex-music-pwa/>

The workflow builds with the deployed Function URL and repository Pages base path. The equivalent local command is:

```sh
VITE_API_BASE_URL=https://ezsc7kdtvlfw3kc2tgb27eqube0ejqdu.lambda-url.eu-central-1.on.aws \
VITE_BASE_PATH=/yandex-music-pwa/ \
npm run build
```

For a renamed repository, custom domain, or root Pages site, update `VITE_BASE_PATH` in `.github/workflows/ci.yml` accordingly.

If the Pages origin changes, redeploy Terraform with the new `ALLOWED_ORIGIN`; otherwise the browser will reject cross-origin API calls.

## Logs

```sh
./scripts/show-logs.sh
SINCE=3d ./scripts/show-logs.sh
FOLLOW=1 ./scripts/show-logs.sh
```

`SINCE` accepts seconds, minutes, hours, or days such as `45s`, `30m`, `12h`, or `3d`. Set `AWS_REGION` and `PROJECT_NAME` when they differ from your AWS CLI/default deployment values.

## Will personal use remain in the AWS free tier?

It is likely for personal use, particularly when Yandex returns a plaintext source that can travel directly to the phone, but the one-million-request number is not the only meter:

- Lambda includes 1,000,000 requests and 400,000 GB-seconds of compute per month in its Free Tier. A 256 MB function therefore has a large personal-use duration allowance: <https://aws.amazon.com/lambda/pricing/>.
- For Lambda response streaming, the first 6 MB of each response has no streaming charge, and the pricing page documents a 100 GB monthly streamed-data Free Tier allowance. Streaming beyond the free amounts is metered separately: <https://aws.amazon.com/lambda/pricing/>.
- AWS currently provides 100 GB per month of internet data transfer out in aggregate across eligible AWS services and Regions, excluding China and GovCloud Regions: <https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer>.
- A fallback stream keeps the function running for the duration of the transfer, so it consumes both streamed-data and GB-second allowances. Lambda also throttles the portion of a streamed response after the first 6 MB to the documented bandwidth rate: <https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html>.

Thus, one million calls can be free while compute duration or transferred bytes are not. Encrypted lossless tracks use Lambda for the entire stream. AWS Free Tier is not a hard billing cap, pricing can change, and a budget alert can arrive only after usage has produced cost. The conditional direct-CDN path, reserved concurrency of two, and optional alert reduce risk, but this project cannot guarantee a $0 bill.

## Install and use on iOS 15

1. Open the deployed HTTPS site in Safari.
2. Tap Share, then **Add to Home Screen**.
3. Open the installed app and press Play once; iOS requires a user gesture before audio can start.
4. Leave the app in the foreground while it saves upcoming tracks.

Preferences only checks the server configuration and reconnects. It never asks for the token. When upgrading from a version that had a credential form, deploy the updated Lambda first, then publish the PWA and close/reopen any already-running Home Screen app once; the removed server route makes a temporarily stale client unable to submit credentials.

iOS caches the Home Screen icon independently of the service worker. After an icon update, remove the existing Home Screen app and add it again; reopening alone does not refresh the small app badge shown over lock-screen artwork.

The lock screen shows the current artwork, title, artist, and album, with play, pause, previous, and next controls. Custom like/dislike lock-screen actions are not part of the Media Session API, so those remain in the app. A track that has started can continue after locking the phone on iOS 15.4 and later. WebKit's standalone-PWA background-audio fix shipped in iOS 15.4, so iOS 15.0–15.3 cannot provide reliable screen-off playback: <https://bugs.webkit.org/show_bug.cgi?id=198277>. The player keeps one connected audio element and prepares only the next source so its `ended` handler can assign that source before yielding to IndexedDB or the network. It also treats `waiting`, `stalled`, and a frozen playback clock as recoverable stream interruptions, temporarily suspending background downloads until audio has made stable progress again. WebKit reports that screen-off sequence working by iOS 15.7.2: <https://bugs.webkit.org/show_bug.cgi?id=221413>. Treat continuous locked-screen queues as requiring iOS 15.7.2 unless a physical-device test establishes an earlier point release.

The service worker keeps the application shell available, while complete audio blobs and artwork are stored in IndexedDB. Preferences lets you keep 0–50 upcoming recommendations offline, defaulting to 10; the chosen limit is stored locally on that device. The rolling cache evicts tracks that fall behind while online and does not prune while offline playback is active. The Offline screen reports the exact bytes stored by this app and lets you play or delete individual downloads or clear all of them.

Download exports the current complete audio file. A cached track can open the iOS file-share sheet on the first tap. For a streaming track, the first tap prepares the complete file and changes the button to **Save file**; the second tap preserves iOS's required user activation and opens the file-share sheet. Firefox uses a normal browser download.

iOS 15 does not provide Background Sync for this use, so configured upcoming tracks are fetched only while the PWA is open. Cached artwork is also supplied to Media Session, keeping the Now Playing image available without a network connection. Safari may evict website data under storage pressure, and neither a PWA nor IndexedDB can promise that downloads are permanent. The displayed usage is this app's stored audio and artwork, not Safari's total per-origin allocation.

## Extractable TypeScript SDK

Reusable music-domain code lives in `src/sdk/` and has no DOM, audio element, IndexedDB, service-worker, or UI dependency. `YandexMusicClient` accepts the small `MusicTransport` interface, so a future package can export the types, recommendation session, cache selection policy, track-link builders, and API client while consumers supply their own HTTP transport.

Browser-specific implementations remain in `src/adapters/`, playback in `src/player/`, and rendering/orchestration in `src/app.ts`. That boundary is intentional: extracting an npm SDK should not require carrying the PWA with it.

## Important limitations

- Yandex Music does not publish or support the endpoints used here. Responses, signatures, and playback rules can change at any time.
- A valid account and any subscription required by Yandex for full-track or high-quality playback remain necessary.
- Signed CDN URLs are short-lived and must not be treated as permanent download links.
- The Function URL is public. Exact-Origin, user-agent, and PWA screen checks stop casual use but are not authentication and can be forged. Anyone who obtains the URL can consume invocations and act through the stored account on the allowlisted routes; reserved concurrency and Budgets are not hard spending caps.
- The private protocol and highest-quality containers have unit-tested signature/decryption handling, but still need a live-account test and a physical iOS 15 smoke test before relying on them in production.
- Before deploying or distributing this client, verify that your use complies with Yandex's current terms, applicable copyright rules, and your AWS account policies.
