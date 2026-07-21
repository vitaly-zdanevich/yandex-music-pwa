//! Native, streaming AWS Lambda proxy for the small Yandex Music API surface
//! used by the PWA. Secrets stay in Lambda/SSM and are never accepted as API
//! authorization headers from the browser.

use std::collections::HashMap;
use std::env;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes::{Aes128, Aes192, Aes256};
use aws_config::BehaviorVersion;
use aws_sdk_ssm::Client as SsmClient;
use axum::Router;
use axum::body::{Body as ResponseBody, to_bytes};
use axum::extract::{Request as AxumRequest, State};
use axum::routing::any;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use bytes::{Bytes, BytesMut};
use ctr::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use lambda_http::http::header::{
    ACCEPT, ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_MAX_AGE,
    AUTHORIZATION, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, HOST, IF_MODIFIED_SINCE, IF_NONE_MATCH, IF_RANGE, LAST_MODIFIED, LOCATION, ORIGIN, RANGE,
    REFERRER_POLICY, RETRY_AFTER, USER_AGENT, VARY, X_CONTENT_TYPE_OPTIONS,
};
use lambda_http::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use lambda_http::{Body as LambdaBody, Request, Response};
use md5::{Digest as _, Md5};
use percent_encoding::percent_decode_str;
use reqwest::redirect::Policy;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, OnceCell};
use url::Url;

const API_ORIGIN: &str = "https://api.music.yandex.net";
const MUSIC_CLIENT: &str = "YandexMusicAndroid/24023621";
const LEGACY_SIGN_SALT: &str = "XGRlBW9FXlekgbPrRHuSiA";
const DEFAULT_HTTP_ADDR: &str = "127.0.0.1:8080";
const MAX_REQUEST_BODY_BYTES: usize = 64_000;
const MAX_JSON_RESPONSE_BYTES: usize = 2_000_000;
const MAX_XML_RESPONSE_BYTES: usize = 128_000;
const MAX_ARTWORK_RESPONSE_BYTES: usize = 5_000_000;
const DEFAULT_SECRET_CACHE_SECONDS: u64 = 300;
const LOSSLESS_QUALITY: &str = "lossless";
const RAW_TRANSPORT: &str = "raw";
const LOSSLESS_CODECS: &[&str] = &[
    "flac-mp4",
    "flac",
    "aac-mp4",
    "aac",
    "he-aac",
    "mp3",
    "he-aac-mp4",
];
const MEDIA_HOST_SUFFIXES: &[&str] = &[
    "yandex.net",
    "yandex.ru",
    "yandex.com",
    "yandexcdn.net",
    "yastatic.net",
];
const ARTWORK_HOSTS: &[&str] = &[
    "avatars.yandex.net",
    "avatars.mds.yandex.net",
    "avatars.mds.yandex.ru",
    "avatars.mds.yandex.com",
];

type ProxyResponse = Response<ResponseBody>;

/// Warm-Lambda application state. HTTP clients, AWS configuration, and
/// decrypted parameters are reused between invocations.
pub struct App {
    api_client: reqwest::Client,
    media_client: reqwest::Client,
    secrets: SecretStore,
    api_origin: Url,
    allowed_origin: Option<HeaderValue>,
    origin_verify: Option<String>,
    public_base_url: Option<Url>,
    http_addr: SocketAddr,
    account_uid: Mutex<Option<CachedAccountUid>>,
}

impl App {
    /// Build application state from environment variables.
    pub fn from_env() -> Result<Self, ConfigError> {
        let allowed_origin = optional_env("ALLOWED_ORIGIN")
            .map(|value| parse_allowed_origin(&value))
            .transpose()?;
        let public_base_url = optional_env("PUBLIC_BASE_URL")
            .map(|value| parse_base_url(&value, "PUBLIC_BASE_URL"))
            .transpose()?;
        let http_addr = optional_env("HTTP_SERVER_ADDR")
            .unwrap_or_else(|| DEFAULT_HTTP_ADDR.to_owned())
            .parse()
            .map_err(|_| ConfigError("HTTP_SERVER_ADDR is invalid"))?;
        let cache_ttl = optional_env("SECRET_CACHE_TTL_SECONDS")
            .map(|value| value.parse::<u64>())
            .transpose()
            .map_err(|_| ConfigError("SECRET_CACHE_TTL_SECONDS must be an integer"))?
            .unwrap_or(DEFAULT_SECRET_CACHE_SECONDS)
            .clamp(1, 3_600);

        let api_origin = match optional_env("YANDEX_API_ORIGIN") {
            Some(value) => parse_base_url(&value, "YANDEX_API_ORIGIN")?,
            None => Url::parse(API_ORIGIN).expect("the static API origin is valid"),
        };

        let api_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .build()
            .map_err(|_| ConfigError("could not initialize the API HTTP client"))?;
        // A full track can take substantially longer than a JSON API request.
        // Lambda itself remains the outer deadline.
        let media_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(45))
            .redirect(Policy::none())
            .build()
            .map_err(|_| ConfigError("could not initialize the media HTTP client"))?;

        Ok(Self {
            api_client,
            media_client,
            secrets: SecretStore::from_env(Duration::from_secs(cache_ttl)),
            api_origin,
            allowed_origin,
            origin_verify: optional_env("ORIGIN_VERIFY")
                .or_else(|| optional_env("ORIGIN_VERIFY_SECRET")),
            public_base_url,
            http_addr,
            account_uid: Mutex::new(None),
        })
    }

    /// Run as a normal HTTP service outside Lambda. This is intentionally a
    /// convenience path; production uses `run_with_streaming_response`.
    pub fn should_self_host() -> bool {
        env::var_os("AWS_LAMBDA_RUNTIME_API").is_none() || env::var_os("HTTP_SERVER_ADDR").is_some()
    }

    /// Local HTTP entry point used for development and integration tests.
    pub async fn run_http_server(self: Arc<Self>) -> Result<(), lambda_http::Error> {
        let listener = tokio::net::TcpListener::bind(self.http_addr).await?;
        let router = Router::new().fallback(any(local_handler)).with_state(self);
        axum::serve(listener, router).await?;
        Ok(())
    }

    /// Convert a Lambda Function URL request to the shared request model.
    pub async fn handle_lambda(&self, request: Request) -> ProxyResponse {
        let (parts, body) = request.into_parts();
        let body = match body {
            LambdaBody::Empty => Bytes::new(),
            LambdaBody::Text(value) => Bytes::from(value),
            LambdaBody::Binary(value) => Bytes::from(value),
            _ => Bytes::new(),
        };
        self.handle(IncomingRequest {
            method: parts.method,
            uri: parts.uri,
            headers: parts.headers,
            body,
        })
        .await
    }

    async fn handle(&self, request: IncomingRequest) -> ProxyResponse {
        let request_origin = request.headers.get(ORIGIN).cloned();
        let mut response = match self.validate_browser_origin(&request) {
            Err(error) => error.into_response(),
            Ok(()) if request.method == Method::OPTIONS => self.preflight_response(&request),
            Ok(()) => match self.validate_origin_verify(&request) {
                Err(error) => error.into_response(),
                Ok(()) => self.dispatch(request).await,
            },
        };

        add_security_headers(&mut response);
        self.add_cors_headers(request_origin.as_ref(), &mut response);
        response
    }

    async fn dispatch(&self, request: IncomingRequest) -> ProxyResponse {
        let path = request.uri.path();
        let result = if path == "/healthz" {
            if request.method == Method::GET || request.method == Method::HEAD {
                return empty_response(StatusCode::NO_CONTENT);
            }
            Err(AppError::method_not_allowed())
        } else if path == "/api/settings/status" {
            self.settings_status(&request).await
        } else if path.starts_with("/api/yandex/") {
            self.proxy_yandex(request).await
        } else if path.starts_with("/api/media/resolve/") {
            self.resolve_media(&request).await
        } else if path == "/api/media/stream" {
            self.stream_media(&request).await
        } else if path == "/api/media/artwork" {
            self.proxy_artwork(&request).await
        } else {
            Err(AppError::new(StatusCode::NOT_FOUND, "Unknown API route"))
        };

        result.unwrap_or_else(AppError::into_response)
    }

    fn validate_browser_origin(&self, request: &IncomingRequest) -> Result<(), AppError> {
        let Some(expected) = self.allowed_origin.as_ref() else {
            return Ok(());
        };
        let Some(actual) = request.headers.get(ORIGIN) else {
            return if request.uri.path().starts_with("/api/") {
                Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "Browser origin is required",
                ))
            } else {
                Ok(())
            };
        };
        if secret_eq(expected.as_bytes(), actual.as_bytes()) {
            Ok(())
        } else {
            Err(AppError::new(
                StatusCode::FORBIDDEN,
                "Origin is not allowed",
            ))
        }
    }

    fn validate_origin_verify(&self, request: &IncomingRequest) -> Result<(), AppError> {
        let Some(expected) = self.origin_verify.as_deref() else {
            return Ok(());
        };
        let actual = request
            .headers
            .get("x-origin-verify")
            .map(HeaderValue::as_bytes)
            .unwrap_or_default();
        if secret_eq(expected.as_bytes(), actual) {
            Ok(())
        } else {
            Err(AppError::new(
                StatusCode::FORBIDDEN,
                "Origin verification failed",
            ))
        }
    }

    fn preflight_response(&self, request: &IncomingRequest) -> ProxyResponse {
        if !request.uri.path().starts_with("/api/") {
            return AppError::new(StatusCode::NOT_FOUND, "Unknown API route").into_response();
        }
        empty_response(StatusCode::NO_CONTENT)
    }

    fn add_cors_headers(&self, origin: Option<&HeaderValue>, response: &mut ProxyResponse) {
        let (Some(expected), Some(actual)) = (self.allowed_origin.as_ref(), origin) else {
            return;
        };
        if !secret_eq(expected.as_bytes(), actual.as_bytes()) {
            return;
        }
        let headers = response.headers_mut();
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, expected.clone());
        headers.insert(VARY, HeaderValue::from_static("Origin"));
        headers.insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST, OPTIONS"),
        );
        headers.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Accept, Content-Type, Range, X-Origin-Verify"),
        );
        headers.insert(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static(
                "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
            ),
        );
        headers.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    }

    async fn settings_status(&self, request: &IncomingRequest) -> Result<ProxyResponse, AppError> {
        if request.method != Method::GET {
            return Err(AppError::method_not_allowed());
        }
        let configured = self.validated_token().await?.is_some();
        Ok(json_response(
            StatusCode::OK,
            &SettingsStatus { configured },
        ))
    }

    async fn proxy_yandex(&self, request: IncomingRequest) -> Result<ProxyResponse, AppError> {
        let path = request
            .uri
            .path()
            .strip_prefix("/api/yandex")
            .unwrap_or_default();
        if !allowed_yandex_route(&request.method, path) {
            return Err(AppError::new(
                StatusCode::NOT_FOUND,
                "Unknown Yandex API route",
            ));
        }
        if request.body.len() > MAX_REQUEST_BODY_BYTES {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "API request is too large",
            ));
        }

        let token = self.required_token().await?;
        let url = self.yandex_url(path, request.uri.query())?;
        let mut upstream = self
            .api_client
            .request(request.method.clone(), url)
            .headers(api_headers(&token)?);
        if let Some(content_type) = request.headers.get(CONTENT_TYPE) {
            upstream = upstream.header(CONTENT_TYPE, content_type.clone());
        }
        if request.method != Method::GET && request.method != Method::HEAD {
            upstream = upstream.body(request.body);
        }
        let upstream = upstream
            .send()
            .await
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Could not reach Yandex Music"))?;
        buffered_upstream_response(
            upstream,
            &[CONTENT_TYPE, RETRY_AFTER],
            "no-store",
            MAX_JSON_RESPONSE_BYTES,
        )
        .await
    }

    async fn resolve_media(&self, request: &IncomingRequest) -> Result<ProxyResponse, AppError> {
        if request.method != Method::GET {
            return Err(AppError::method_not_allowed());
        }
        let encoded_id = request
            .uri
            .path()
            .strip_prefix("/api/media/resolve/")
            .unwrap_or_default();
        let track_id = decode_identifier(encoded_id)
            .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid track id"))?;
        let token = self.required_token().await?;

        let media = match self.resolve_current_file_info(&track_id, &token).await {
            Ok(media) => media,
            Err(_) => self.resolve_legacy_download_info(&track_id, &token).await?,
        };
        let direct_url = media
            .decryption_key
            .is_none()
            .then(|| media.remote_url.as_str().to_owned());
        // Audio fallbacks carry only a track id. Lambda resolves a fresh
        // short-lived CDN URL (and any decryption key) on every new stream;
        let stream_query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("track", &track_id)
            .finish();
        let stream_path = format!("/api/media/stream?{stream_query}");
        let url = self
            .public_request_base(request)
            .map(|base| format!("{}{stream_path}", base.as_str().trim_end_matches('/')))
            .unwrap_or(stream_path);
        Ok(json_response(
            StatusCode::OK,
            &ResolvedMediaResponse {
                url,
                direct_url,
                codec: media.codec,
                bitrate: media.bitrate,
                quality: media.quality,
            },
        ))
    }

    async fn stream_media(&self, request: &IncomingRequest) -> Result<ProxyResponse, AppError> {
        if request.method != Method::GET && request.method != Method::HEAD {
            return Err(AppError::method_not_allowed());
        }
        let track_id = query_parameter(request.uri.query(), "track")
            .and_then(|value| decode_identifier(&value))
            .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid track id"))?;
        let token = self.required_token().await?;
        let media = match self.resolve_current_file_info(&track_id, &token).await {
            Ok(media) => media,
            Err(_) => self.resolve_legacy_download_info(&track_id, &token).await?,
        };
        let remote_url = media.remote_url;
        let decryption_key = media.decryption_key;
        let codec = Some(media.codec);
        if !is_allowed_media_url(&remote_url) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "Unsupported media host",
            ));
        }

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(MUSIC_CLIENT));
        for name in [RANGE, IF_RANGE, IF_NONE_MATCH, IF_MODIFIED_SINCE] {
            if let Some(value) = request.headers.get(&name)
                && value.as_bytes().len() <= 256
            {
                headers.insert(name, value.clone());
            }
        }
        let upstream = self
            .request_media(
                request.method.clone(),
                remote_url,
                headers,
                is_allowed_media_url,
            )
            .await?;

        let copied_headers = [
            ACCEPT_RANGES,
            CONTENT_LENGTH,
            CONTENT_RANGE,
            CONTENT_TYPE,
            CONTENT_ENCODING,
            ETAG,
            LAST_MODIFIED,
        ];
        let mut response = if let Some(key) = decryption_key {
            stream_decrypted_upstream_response(
                upstream,
                &key,
                &copied_headers,
                request.method == Method::HEAD,
            )?
        } else {
            stream_upstream_response(
                upstream,
                &copied_headers,
                "private, max-age=300",
                request.method == Method::HEAD,
            )
        };
        if let Some(content_type) = codec.as_deref().and_then(codec_content_type) {
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        }
        Ok(response)
    }

    async fn proxy_artwork(&self, request: &IncomingRequest) -> Result<ProxyResponse, AppError> {
        if request.method != Method::GET && request.method != Method::HEAD {
            return Err(AppError::method_not_allowed());
        }
        let encoded = query_parameter(request.uri.query(), "source")
            .filter(|value| !value.is_empty() && value.len() <= 8_192)
            .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "Invalid artwork source"))?;
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "Invalid artwork source"))?;
        let remote_url = Url::parse(
            std::str::from_utf8(&decoded)
                .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "Invalid artwork source"))?,
        )
        .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "Invalid artwork source"))?;
        if !is_allowed_artwork_url(&remote_url) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "Unsupported artwork host",
            ));
        }

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(MUSIC_CLIENT));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("image/webp,image/png,image/jpeg"),
        );
        let upstream = self
            .request_media(
                request.method.clone(),
                remote_url,
                headers,
                is_allowed_artwork_url,
            )
            .await?;
        if !upstream.status().is_success() {
            return Err(upstream_error(upstream.status(), "Could not load artwork"));
        }
        if upstream
            .content_length()
            .is_some_and(|length| length > MAX_ARTWORK_RESPONSE_BYTES as u64)
        {
            return Err(AppError::new(
                StatusCode::BAD_GATEWAY,
                "Artwork is too large",
            ));
        }
        let content_type = upstream
            .headers()
            .get(CONTENT_TYPE)
            .filter(|value| is_supported_artwork_content_type(value))
            .cloned()
            .ok_or_else(|| AppError::new(StatusCode::BAD_GATEWAY, "Unsupported artwork type"))?;
        if request.method == Method::HEAD {
            return Ok(stream_upstream_response(
                upstream,
                &[CONTENT_LENGTH, CONTENT_TYPE, ETAG, LAST_MODIFIED],
                "private, max-age=86400",
                true,
            ));
        }
        let mut response = buffered_upstream_response(
            upstream,
            &[ETAG, LAST_MODIFIED],
            "private, max-age=86400",
            MAX_ARTWORK_RESPONSE_BYTES,
        )
        .await?;
        response.headers_mut().insert(CONTENT_TYPE, content_type);
        Ok(response)
    }

    async fn request_media(
        &self,
        method: Method,
        mut url: Url,
        headers: HeaderMap,
        is_allowed: fn(&Url) -> bool,
    ) -> Result<reqwest::Response, AppError> {
        for redirect_count in 0..=2 {
            let upstream = self
                .media_client
                .request(method.clone(), url.clone())
                .headers(headers.clone())
                .send()
                .await
                .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Could not load media"))?;
            let Some(location) = upstream.headers().get(LOCATION) else {
                return Ok(upstream);
            };
            if !upstream.status().is_redirection() {
                return Ok(upstream);
            }
            if redirect_count == 2 {
                return Err(AppError::new(
                    StatusCode::BAD_GATEWAY,
                    "Too many media redirects",
                ));
            }
            let location = location
                .to_str()
                .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Invalid media redirect"))?;
            let next = url
                .join(location)
                .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Invalid media redirect"))?;
            if !is_allowed(&next) {
                return Err(AppError::new(
                    StatusCode::BAD_GATEWAY,
                    "Unsupported media redirect",
                ));
            }
            url = next;
        }
        unreachable!("the redirect loop always returns")
    }

    async fn resolve_current_file_info(
        &self,
        track_id: &str,
        token: &str,
    ) -> Result<ResolvedMedia, AppError> {
        let signing_key = self.secrets.signing_key().await?.ok_or_else(|| {
            AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Media signing key is not configured",
            )
        })?;
        let timestamp = unix_timestamp()?;
        let codecs = LOSSLESS_CODECS.join(",");
        let mut url = self.yandex_url("/get-file-info", None)?;
        url.query_pairs_mut()
            .append_pair("ts", &timestamp.to_string())
            .append_pair("trackId", track_id)
            .append_pair("quality", LOSSLESS_QUALITY)
            .append_pair("codecs", &codecs)
            .append_pair("transports", RAW_TRANSPORT)
            .append_pair("sign", &sign_file_info(track_id, timestamp, &signing_key));

        // Older accounts/endpoints can omit this header, so media resolution
        // may still fall back to the token-only request after token setup has
        // already performed strict account validation.
        let account_uid = self.account_uid(token).await.ok();
        let upstream = self
            .api_client
            .get(url)
            .headers(file_info_headers(token, account_uid.as_deref())?)
            .send()
            .await
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Could not resolve media"))?;
        let info = read_file_info(upstream).await?;
        let codec = info.codec.trim().to_ascii_lowercase();
        if !LOSSLESS_CODECS.contains(&codec.as_str()) {
            return Err(AppError::new(
                StatusCode::BAD_GATEWAY,
                "No supported full-quality audio is available",
            ));
        }
        let remote_url = info
            .url
            .into_iter()
            .chain(info.urls)
            .filter_map(|value| Url::parse(&value).ok())
            .find(is_allowed_media_url)
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::BAD_GATEWAY,
                    "No supported full-quality audio is available",
                )
            })?;
        let decryption_key = info
            .key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(decode_aes_key)
            .transpose()?;
        Ok(ResolvedMedia {
            remote_url,
            codec,
            bitrate: info.bitrate.unwrap_or_default(),
            quality: info.quality.unwrap_or_else(|| LOSSLESS_QUALITY.to_owned()),
            decryption_key,
        })
    }

    async fn resolve_legacy_download_info(
        &self,
        track_id: &str,
        token: &str,
    ) -> Result<ResolvedMedia, AppError> {
        let path = format!("/tracks/{track_id}/download-info");
        let upstream = self
            .api_client
            .get(self.yandex_url(&path, None)?)
            .headers(api_headers(token)?)
            .send()
            .await
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Could not resolve media"))?;
        let mut items: Vec<DownloadInfo> = read_json_envelope(upstream).await?;
        items.sort_by_key(|item| std::cmp::Reverse(item.bitrate_in_kbps.unwrap_or_default()));
        let selected = items
            .into_iter()
            .find(|item| {
                item.codec.as_deref().is_some_and(is_legacy_codec_supported)
                    && item.preview != Some(true)
                    && item.download_info_url.is_some()
            })
            .ok_or_else(|| {
                AppError::new(StatusCode::BAD_GATEWAY, "No full-track audio is available")
            })?;
        let info_url = Url::parse(selected.download_info_url.as_deref().unwrap_or_default())
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Invalid media metadata URL"))?;
        if !is_allowed_media_url(&info_url) {
            return Err(AppError::new(
                StatusCode::BAD_GATEWAY,
                "Unsupported media metadata host",
            ));
        }

        let upstream = self
            .api_client
            .get(info_url)
            .headers(api_headers(token)?)
            .send()
            .await
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Could not load media metadata"))?;
        if !upstream.status().is_success() {
            return Err(upstream_error(
                upstream.status(),
                "Could not load media metadata",
            ));
        }
        let xml = limited_bytes(upstream, MAX_XML_RESPONSE_BYTES).await?;
        let remote_url = build_legacy_media_url(
            std::str::from_utf8(&xml)
                .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Invalid media metadata"))?,
        )?;
        let codec = selected.codec.unwrap_or_else(|| "mp3".to_owned());
        Ok(ResolvedMedia {
            remote_url,
            codec,
            bitrate: selected.bitrate_in_kbps.unwrap_or_default(),
            quality: "high".to_owned(),
            decryption_key: None,
        })
    }

    async fn account_uid(&self, token: &str) -> Result<String, AppError> {
        let token_fingerprint: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        {
            let cached = self.account_uid.lock().await;
            if let Some(cached) = cached.as_ref().filter(|cached| {
                cached.token_fingerprint == token_fingerprint
                    && cached.fetched_at.elapsed() <= Duration::from_secs(300)
            }) {
                return Ok(cached.uid.clone());
            }
        }

        let upstream = self
            .api_client
            .get(self.yandex_url("/account/status", None)?)
            .headers(api_headers(token)?)
            .send()
            .await
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Could not read account status"))?;
        let result: AccountStatusResult = read_json_envelope(upstream).await?;
        let uid = account_uid_from_status(result)?;
        *self.account_uid.lock().await = Some(CachedAccountUid {
            token_fingerprint,
            uid: uid.clone(),
            fetched_at: Instant::now(),
        });
        Ok(uid)
    }

    async fn required_token(&self) -> Result<String, AppError> {
        self.validated_token().await?.ok_or_else(|| {
            AppError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Yandex Music token is not configured",
            )
        })
    }

    async fn validated_token(&self) -> Result<Option<String>, AppError> {
        self.secrets
            .token()
            .await?
            .map(validate_token)
            .transpose()
            .map_err(|_| {
                AppError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Invalid server token configuration",
                )
            })
    }

    fn yandex_url(&self, path: &str, query: Option<&str>) -> Result<Url, AppError> {
        let mut value = format!("{}{}", self.api_origin.as_str().trim_end_matches('/'), path);
        if let Some(query) = query.filter(|value| !value.is_empty()) {
            value.push('?');
            value.push_str(query);
        }
        Url::parse(&value)
            .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "Invalid upstream URL"))
    }

    fn public_request_base(&self, request: &IncomingRequest) -> Option<Url> {
        if let Some(base) = self.public_base_url.clone() {
            return Some(base);
        }
        if request.uri.scheme().is_some() && request.uri.authority().is_some() {
            return Url::parse(&format!(
                "{}://{}",
                request.uri.scheme_str()?,
                request.uri.authority()?
            ))
            .ok();
        }
        let host = request.headers.get(HOST)?.to_str().ok()?;
        if host.contains('/') || host.contains('@') || host.chars().any(char::is_whitespace) {
            return None;
        }
        let scheme = request
            .headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .filter(|value| *value == "http" || *value == "https")
            .unwrap_or("https");
        Url::parse(&format!("{scheme}://{host}")).ok()
    }
}

async fn local_handler(State(app): State<Arc<App>>, request: AxumRequest) -> ProxyResponse {
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_REQUEST_BODY_BYTES + 1).await {
        Ok(body) if body.len() <= MAX_REQUEST_BODY_BYTES => body,
        _ => {
            return AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "API request is too large")
                .into_response();
        }
    };
    app.handle(IncomingRequest {
        method: parts.method,
        uri: parts.uri,
        headers: parts.headers,
        body,
    })
    .await
}

struct IncomingRequest {
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
}

#[derive(Clone)]
struct SecretLocator {
    environment: Option<String>,
    parameter: Option<String>,
}

struct SecretStore {
    token: SecretLocator,
    signing_key: SecretLocator,
    cache_ttl: Duration,
    cache: Mutex<HashMap<SecretKind, CachedSecret>>,
    ssm: OnceCell<SsmClient>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum SecretKind {
    Token,
    SigningKey,
}

struct CachedSecret {
    value: String,
    fetched_at: Instant,
}

impl SecretStore {
    fn from_env(cache_ttl: Duration) -> Self {
        Self {
            token: SecretLocator {
                environment: optional_env("YANDEX_MUSIC_TOKEN")
                    .or_else(|| optional_env("YANDEX_TOKEN")),
                parameter: optional_env("TOKEN_PARAMETER"),
            },
            signing_key: SecretLocator {
                environment: optional_env("SIGNING_KEY")
                    .or_else(|| optional_env("FILE_INFO_SIGNING_KEY")),
                parameter: optional_env("SIGNING_KEY_PARAMETER"),
            },
            cache_ttl,
            cache: Mutex::new(HashMap::new()),
            ssm: OnceCell::new(),
        }
    }

    async fn token(&self) -> Result<Option<String>, AppError> {
        self.read(SecretKind::Token, &self.token).await
    }

    async fn signing_key(&self) -> Result<Option<String>, AppError> {
        self.read(SecretKind::SigningKey, &self.signing_key).await
    }

    async fn read(
        &self,
        kind: SecretKind,
        locator: &SecretLocator,
    ) -> Result<Option<String>, AppError> {
        let Some(parameter) = locator.parameter.as_deref() else {
            return Ok(locator.environment.clone());
        };

        let stale = {
            let cache = self.cache.lock().await;
            cache.get(&kind).map(|cached| {
                (
                    cached.value.clone(),
                    cached.fetched_at.elapsed() <= self.cache_ttl,
                )
            })
        };
        if let Some((value, true)) = stale.as_ref() {
            return Ok(Some(value.clone()));
        }

        let result = self
            .ssm_client()
            .await
            .get_parameter()
            .name(parameter)
            .with_decryption(true)
            .send()
            .await;
        match result {
            Ok(output) => {
                let value = output
                    .parameter()
                    .and_then(|parameter| parameter.value())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                let mut cache = self.cache.lock().await;
                if let Some(value) = value.as_ref() {
                    cache.insert(
                        kind,
                        CachedSecret {
                            value: value.clone(),
                            fetched_at: Instant::now(),
                        },
                    );
                } else {
                    cache.remove(&kind);
                }
                Ok(value)
            }
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|service| service.is_parameter_not_found()) =>
            {
                self.cache.lock().await.remove(&kind);
                Ok(None)
            }
            Err(_) => stale.map(|(value, _)| Some(value)).ok_or_else(ssm_error),
        }
    }

    async fn ssm_client(&self) -> &SsmClient {
        self.ssm
            .get_or_init(|| async {
                let config = aws_config::defaults(BehaviorVersion::latest()).load().await;
                SsmClient::new(&config)
            })
            .await
    }
}

fn ssm_error() -> AppError {
    AppError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "Secure parameter storage is temporarily unavailable",
    )
}

#[derive(Serialize)]
struct SettingsStatus {
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedMediaResponse {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_url: Option<String>,
    codec: String,
    bitrate: u32,
    quality: String,
}

struct ResolvedMedia {
    remote_url: Url,
    codec: String,
    bitrate: u32,
    quality: String,
    decryption_key: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct FileInfoEnvelope {
    #[serde(default, alias = "downloadInfo")]
    download_info: Option<FileDownloadInfo>,
    result: Option<FileInfoResult>,
}

#[derive(Deserialize)]
struct FileInfoResult {
    #[serde(default, alias = "downloadInfo")]
    download_info: Option<FileDownloadInfo>,
}

#[derive(Deserialize)]
struct FileDownloadInfo {
    bitrate: Option<u32>,
    #[serde(default)]
    codec: String,
    quality: Option<String>,
    key: Option<String>,
    url: Option<String>,
    #[serde(default)]
    urls: Vec<String>,
}

struct CachedAccountUid {
    token_fingerprint: [u8; 32],
    uid: String,
    fetched_at: Instant,
}

#[derive(Deserialize)]
struct AccountStatusResult {
    account: Option<AccountStatusAccount>,
    uid: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct AccountStatusAccount {
    uid: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadInfo {
    codec: Option<String>,
    bitrate_in_kbps: Option<u32>,
    preview: Option<bool>,
    download_info_url: Option<String>,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    result: Option<T>,
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    error: &'a str,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: &'static str,
}

impl AppError {
    const fn new(status: StatusCode, message: &'static str) -> Self {
        Self { status, message }
    }

    const fn method_not_allowed() -> Self {
        Self::new(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
    }

    fn into_response(self) -> ProxyResponse {
        eprintln!(
            "proxy request failed: status={} message={}",
            self.status.as_u16(),
            self.message
        );
        json_response(
            self.status,
            &ErrorEnvelope {
                error: self.message,
            },
        )
    }
}

/// Startup configuration error. Messages deliberately never contain secret
/// values or parameter names.
#[derive(Debug)]
pub struct ConfigError(&'static str);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ConfigError {}

fn empty_response(status: StatusCode) -> ProxyResponse {
    Response::builder()
        .status(status)
        .body(ResponseBody::empty())
        .expect("static response is valid")
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> ProxyResponse {
    let bytes =
        serde_json::to_vec(value).unwrap_or_else(|_| b"{\"error\":\"Internal error\"}".to_vec());
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(CONTENT_LENGTH, bytes.len())
        .header(CACHE_CONTROL, "no-store")
        .body(ResponseBody::from(bytes))
        .expect("static JSON response headers are valid")
}

fn add_security_headers(response: &mut ProxyResponse) {
    response
        .headers_mut()
        .insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
        .headers_mut()
        .insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
}

fn stream_upstream_response(
    upstream: reqwest::Response,
    copied_headers: &[HeaderName],
    cache_control: &'static str,
    empty_body: bool,
) -> ProxyResponse {
    let status = upstream.status();
    let source_headers = upstream.headers().clone();
    let mut builder = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, cache_control);
    for name in copied_headers {
        if let Some(value) = source_headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    let body = if empty_body {
        ResponseBody::empty()
    } else {
        ResponseBody::from_stream(upstream.bytes_stream())
    };
    builder
        .body(body)
        .expect("upstream headers are already valid")
}

async fn buffered_upstream_response(
    upstream: reqwest::Response,
    copied_headers: &[HeaderName],
    cache_control: &'static str,
    limit: usize,
) -> Result<ProxyResponse, AppError> {
    let status = upstream.status();
    let source_headers = upstream.headers().clone();
    let bytes = limited_bytes(upstream, limit).await?;
    let mut builder = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, cache_control)
        .header(CONTENT_LENGTH, bytes.len());
    for name in copied_headers {
        if let Some(value) = source_headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    Ok(builder
        .body(ResponseBody::from(bytes))
        .expect("upstream headers are already valid"))
}

fn stream_decrypted_upstream_response(
    upstream: reqwest::Response,
    key: &[u8],
    copied_headers: &[HeaderName],
    empty_body: bool,
) -> Result<ProxyResponse, AppError> {
    let status = upstream.status();
    let source_headers = upstream.headers().clone();
    let offset = encrypted_response_offset(status, &source_headers)?;
    let mut cipher = AesCtrCipher::new(key, offset)?;
    let mut builder = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "private, max-age=300");
    for name in copied_headers {
        if let Some(value) = source_headers.get(name) {
            builder = builder.header(name, value);
        }
    }
    if empty_body || status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(builder
            .body(ResponseBody::empty())
            .expect("upstream headers are already valid"));
    }

    let mut source = Box::pin(upstream.bytes_stream());
    let decrypted = async_stream::stream! {
        while let Some(item) = source.next().await {
            match item {
                Ok(chunk) => {
                    let mut chunk = chunk.to_vec();
                    if cipher.apply(&mut chunk).is_err() {
                        yield Err::<Bytes, std::io::Error>(std::io::Error::other("media decryption failed"));
                        break;
                    }
                    yield Ok(Bytes::from(chunk));
                }
                Err(_) => {
                    yield Err(std::io::Error::other("upstream media stream failed"));
                    break;
                }
            }
        }
    };
    Ok(builder
        .body(ResponseBody::from_stream(decrypted))
        .expect("upstream headers are already valid"))
}

enum AesCtrCipher {
    Aes128(ctr::Ctr128BE<Aes128>),
    Aes192(ctr::Ctr128BE<Aes192>),
    Aes256(ctr::Ctr128BE<Aes256>),
}

impl AesCtrCipher {
    fn new(key: &[u8], offset: u64) -> Result<Self, AppError> {
        let iv = [0_u8; 16];
        let mut cipher = match key.len() {
            16 => Self::Aes128(
                ctr::Ctr128BE::<Aes128>::new_from_slices(key, &iv)
                    .map_err(|_| invalid_decryption_key())?,
            ),
            24 => Self::Aes192(
                ctr::Ctr128BE::<Aes192>::new_from_slices(key, &iv)
                    .map_err(|_| invalid_decryption_key())?,
            ),
            32 => Self::Aes256(
                ctr::Ctr128BE::<Aes256>::new_from_slices(key, &iv)
                    .map_err(|_| invalid_decryption_key())?,
            ),
            _ => return Err(invalid_decryption_key()),
        };
        cipher.seek(offset);
        Ok(cipher)
    }

    fn seek(&mut self, offset: u64) {
        match self {
            Self::Aes128(cipher) => cipher.seek(offset),
            Self::Aes192(cipher) => cipher.seek(offset),
            Self::Aes256(cipher) => cipher.seek(offset),
        }
    }

    fn apply(&mut self, bytes: &mut [u8]) -> Result<(), AppError> {
        let result = match self {
            Self::Aes128(cipher) => cipher.try_apply_keystream(bytes),
            Self::Aes192(cipher) => cipher.try_apply_keystream(bytes),
            Self::Aes256(cipher) => cipher.try_apply_keystream(bytes),
        };
        result.map_err(|_| {
            AppError::new(
                StatusCode::BAD_GATEWAY,
                "Media decryption stream overflowed",
            )
        })
    }
}

fn encrypted_response_offset(status: StatusCode, headers: &HeaderMap) -> Result<u64, AppError> {
    if status != StatusCode::PARTIAL_CONTENT {
        return Ok(0);
    }
    let value = headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::new(StatusCode::BAD_GATEWAY, "Invalid media range response"))?;
    let range = value
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/').map(|(range, _)| range))
        .and_then(|range| range.split_once('-').map(|(start, _)| start))
        .and_then(|start| start.parse::<u64>().ok())
        .ok_or_else(|| AppError::new(StatusCode::BAD_GATEWAY, "Invalid media range response"))?;
    Ok(range)
}

fn validate_token(token: String) -> Result<String, AppError> {
    let token = token.trim();
    if !(8..=4_096).contains(&token.len()) || token.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(AppError::new(StatusCode::BAD_REQUEST, "Invalid token"));
    }
    Ok(token.to_owned())
}

fn api_headers(token: &str) -> Result<HeaderMap, AppError> {
    let authorization = HeaderValue::from_str(&format!("OAuth {token}")).map_err(|_| {
        AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Invalid server token configuration",
        )
    })?;
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert("accept-language", HeaderValue::from_static("en"));
    headers.insert(
        "x-yandex-music-client",
        HeaderValue::from_static(MUSIC_CLIENT),
    );
    headers.insert(AUTHORIZATION, authorization);
    Ok(headers)
}

fn file_info_headers(token: &str, account_uid: Option<&str>) -> Result<HeaderMap, AppError> {
    let mut headers = api_headers(token)?;
    headers.insert(USER_AGENT, HeaderValue::from_static("YandexMusicAPI/1.0.0"));
    headers.insert(
        "x-yandex-music-client",
        HeaderValue::from_static("YandexMusicWebNext/1.0.0"),
    );
    headers.insert(
        "x-yandex-music-without-invocation-info",
        HeaderValue::from_static("1"),
    );
    headers.insert(
        "referer",
        HeaderValue::from_static("https://music.yandex.ru/"),
    );
    headers.insert(ORIGIN, HeaderValue::from_static("https://music.yandex.ru"));
    if let Some(account_uid) = account_uid {
        let value = HeaderValue::from_str(account_uid)
            .map_err(|_| AppError::new(StatusCode::BAD_GATEWAY, "Invalid Yandex account id"))?;
        headers.insert("x-yandex-music-multi-auth-user-id", value);
    }
    Ok(headers)
}

async fn read_file_info(upstream: reqwest::Response) -> Result<FileDownloadInfo, AppError> {
    let status = upstream.status();
    if !status.is_success() {
        return Err(upstream_error(status, "Yandex Music media request failed"));
    }
    let bytes = limited_bytes(upstream, MAX_JSON_RESPONSE_BYTES).await?;
    parse_file_info(&bytes)
}

fn parse_file_info(bytes: &[u8]) -> Result<FileDownloadInfo, AppError> {
    let envelope: FileInfoEnvelope = serde_json::from_slice(bytes).map_err(|_| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            "Yandex Music returned invalid media information",
        )
    })?;
    envelope
        .download_info
        .or_else(|| envelope.result.and_then(|result| result.download_info))
        .ok_or_else(|| {
            AppError::new(
                StatusCode::BAD_GATEWAY,
                "Yandex Music returned incomplete media information",
            )
        })
}

async fn read_json_envelope<T: DeserializeOwned>(
    upstream: reqwest::Response,
) -> Result<T, AppError> {
    let status = upstream.status();
    if !status.is_success() {
        return Err(upstream_error(status, "Yandex Music request failed"));
    }
    let bytes = limited_bytes(upstream, MAX_JSON_RESPONSE_BYTES).await?;
    let envelope: ApiEnvelope<T> = serde_json::from_slice(&bytes).map_err(|_| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            "Yandex Music returned invalid JSON",
        )
    })?;
    envelope.result.ok_or_else(|| {
        AppError::new(
            StatusCode::BAD_GATEWAY,
            "Yandex Music returned an incomplete response",
        )
    })
}

async fn limited_bytes(upstream: reqwest::Response, limit: usize) -> Result<Bytes, AppError> {
    let content_length = upstream.content_length();
    if content_length.is_some_and(|length| length > limit as u64) {
        return Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            "Upstream response is too large",
        ));
    }
    let capacity = content_length.unwrap_or_default().min(limit as u64) as usize;
    let mut bytes = BytesMut::with_capacity(capacity);
    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            AppError::new(StatusCode::BAD_GATEWAY, "Could not read upstream response")
        })?;
        append_limited(&mut bytes, &chunk, limit)?;
    }
    Ok(bytes.freeze())
}

fn append_limited(target: &mut BytesMut, chunk: &[u8], limit: usize) -> Result<(), AppError> {
    if chunk.len() > limit.saturating_sub(target.len()) {
        return Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            "Upstream response is too large",
        ));
    }
    target.extend_from_slice(chunk);
    Ok(())
}

fn upstream_error(status: StatusCode, fallback: &'static str) -> AppError {
    let status = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        status
    } else if status.is_client_error() {
        StatusCode::BAD_GATEWAY
    } else {
        status
    };
    AppError::new(status, fallback)
}

fn allowed_yandex_route(method: &Method, path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    match (method, parts.as_slice()) {
        (&Method::GET, ["", "account", "status"]) => true,
        (&Method::POST, ["", "rotor", "session", "new"]) => true,
        (&Method::POST, ["", "rotor", "session", session, "tracks" | "feedback"]) => {
            decode_identifier(session).is_some()
        }
        (&Method::GET, ["", "users", uid, "likes", "tracks"]) => decode_identifier(uid).is_some(),
        (&Method::POST, ["", "tracks"]) => true,
        (&Method::POST, ["", "users", uid, kind, "tracks", action]) => {
            decode_identifier(uid).is_some()
                && matches!(*kind, "likes" | "dislikes")
                && matches!(*action, "add-multiple" | "remove")
        }
        _ => false,
    }
}

fn decode_identifier(value: &str) -> Option<String> {
    let decoded = percent_decode_str(value).decode_utf8().ok()?;
    if decoded.is_empty()
        || decoded.len() > 100
        || !decoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'-'))
    {
        return None;
    }
    Some(decoded.into_owned())
}

fn decode_aes_key(value: &str) -> Result<Vec<u8>, AppError> {
    let bytes = value.as_bytes();
    if !matches!(bytes.len(), 32 | 48 | 64) {
        return Err(invalid_decryption_key());
    }
    let mut decoded = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let high = hex_nibble(pair[0]).ok_or_else(invalid_decryption_key)?;
        let low = hex_nibble(pair[1]).ok_or_else(invalid_decryption_key)?;
        decoded.push((high << 4) | low);
    }
    Ok(decoded)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn invalid_decryption_key() -> AppError {
    AppError::new(
        StatusCode::BAD_GATEWAY,
        "Yandex Music returned an invalid media key",
    )
}

fn is_legacy_codec_supported(codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    LOSSLESS_CODECS.contains(&codec.as_str())
}

fn codec_content_type(codec: &str) -> Option<&'static str> {
    match codec.trim().to_ascii_lowercase().as_str() {
        "flac" => Some("audio/flac"),
        "flac-mp4" | "aac-mp4" | "he-aac-mp4" => Some("audio/mp4"),
        "aac" | "he-aac" => Some("audio/aac"),
        "mp3" => Some("audio/mpeg"),
        _ => None,
    }
}

fn json_identifier(value: serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(value) if !value.trim().is_empty() => Some(value),
        serde_json::Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn account_uid_from_status(result: AccountStatusResult) -> Result<String, AppError> {
    result
        .account
        .and_then(|account| account.uid)
        .or(result.uid)
        .and_then(json_identifier)
        .ok_or_else(|| AppError::new(StatusCode::UNAUTHORIZED, "Yandex Music token is invalid"))
}

/// Restrict media proxying to Yandex-owned HTTPS hosts, preventing the encoded
/// stream URL from becoming a general-purpose SSRF primitive.
pub fn is_allowed_media_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    MEDIA_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn is_allowed_artwork_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return false;
    }
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    ARTWORK_HOSTS.contains(&host.as_str())
        && (url.path().starts_with("/get-music-content/") || url.path().starts_with("/get/"))
}

fn is_supported_artwork_content_type(value: &HeaderValue) -> bool {
    let Ok(value) = value.to_str() else {
        return false;
    };
    matches!(
        value.split(';').next().map(str::trim),
        Some("image/jpeg" | "image/png" | "image/webp")
    )
}

/// HMAC used by Yandex's current `get-file-info` endpoint.
pub fn sign_file_info(track_id: &str, timestamp: u64, signing_key: &str) -> String {
    let codecs = LOSSLESS_CODECS.concat();
    let message = format!("{timestamp}{track_id}{LOSSLESS_QUALITY}{codecs}{RAW_TRANSPORT}");
    let mut mac = Hmac::<Sha256>::new_from_slice(signing_key.as_bytes())
        .expect("HMAC accepts signing keys of any length");
    mac.update(message.as_bytes());
    STANDARD_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Turn legacy XML download metadata into the signed CDN URL.
pub fn build_legacy_media_url(xml: &str) -> Result<Url, &'static str> {
    let host = xml_tag(xml, "host").ok_or("Download metadata has no host")?;
    let path = xml_tag(xml, "path").ok_or("Download metadata has no path")?;
    let timestamp = xml_tag(xml, "ts").ok_or("Download metadata has no timestamp")?;
    let secret = xml_tag(xml, "s").ok_or("Download metadata has no secret")?;
    if !path.starts_with('/') {
        return Err("Download metadata has an invalid path");
    }
    let digest = Md5::digest(format!("{LEGACY_SIGN_SALT}{}{secret}", &path[1..]).as_bytes());
    let url = Url::parse(&format!(
        "https://{host}/get-mp3/{digest:x}/{timestamp}{path}"
    ))
    .map_err(|_| "Download metadata returned an invalid URL")?;
    if !is_allowed_media_url(&url) {
        return Err("Download metadata returned an unsupported host");
    }
    Ok(url)
}

fn xml_tag(xml: &str, tag: &str) -> Option<String> {
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let start = xml.find(&start_tag)? + start_tag.len();
    let end = xml[start..].find(&end_tag)? + start;
    if xml[start..end].contains('<') {
        return None;
    }
    Some(decode_xml_entities(&xml[start..end]))
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
}

fn unix_timestamp() -> Result<u64, AppError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, "System clock is invalid"))
}

fn query_parameter(query: Option<&str>, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query?.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn secret_eq(expected: &[u8], actual: &[u8]) -> bool {
    expected.len() == actual.len() && bool::from(expected.ct_eq(actual))
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn parse_allowed_origin(value: &str) -> Result<HeaderValue, ConfigError> {
    if value == "*" {
        return Err(ConfigError("ALLOWED_ORIGIN must be an exact HTTPS origin"));
    }
    let url = parse_base_url(value, "ALLOWED_ORIGIN")?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(ConfigError("ALLOWED_ORIGIN must contain only an origin"));
    }
    HeaderValue::from_str(&url.origin().ascii_serialization())
        .map_err(|_| ConfigError("ALLOWED_ORIGIN is invalid"))
}

fn parse_base_url(value: &str, _name: &'static str) -> Result<Url, ConfigError> {
    let url = Url::parse(value).map_err(|_| ConfigError("configured URL is invalid"))?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(ConfigError("configured URL must be an HTTPS origin"));
    }
    Ok(url)
}

impl From<&'static str> for AppError {
    fn from(message: &'static str) -> Self {
        AppError::new(StatusCode::BAD_GATEWAY, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yandex_route_allowlist_is_exact() {
        for (method, path) in [
            (Method::GET, "/account/status"),
            (Method::POST, "/rotor/session/new"),
            (Method::POST, "/rotor/session/session-1/tracks"),
            (Method::POST, "/rotor/session/session-1/feedback"),
            (Method::GET, "/users/42/likes/tracks"),
            (Method::POST, "/tracks"),
            (Method::POST, "/users/42/likes/tracks/add-multiple"),
            (Method::POST, "/users/42/likes/tracks/remove"),
            (Method::POST, "/users/42/dislikes/tracks/add-multiple"),
            (Method::POST, "/users/42/dislikes/tracks/remove"),
        ] {
            assert!(allowed_yandex_route(&method, path), "{method} {path}");
        }

        for (method, path) in [
            (Method::POST, "/account/status"),
            (Method::GET, "/rotor/session/new"),
            (Method::POST, "/rotor/session/../tracks"),
            (Method::GET, "/users/42/dislikes/tracks"),
            (Method::POST, "/users/42/likes/tracks/delete-all"),
            (Method::GET, "/search"),
            (Method::DELETE, "/tracks"),
        ] {
            assert!(!allowed_yandex_route(&method, path), "{method} {path}");
        }
    }

    #[test]
    fn media_hosts_are_strictly_yandex_owned_https_hosts() {
        for value in [
            "https://music.yandex.ru/file.mp3",
            "https://avatars.yandex.net/cover.jpg",
            "https://foo.yandexcdn.net:443/a",
        ] {
            assert!(is_allowed_media_url(&Url::parse(value).unwrap()), "{value}");
        }
        for value in [
            "http://music.yandex.ru/file.mp3",
            "https://yandex.ru.evil.example/file.mp3",
            "https://evil-yandex.net/file.mp3",
            "https://user@yandex.net/file.mp3",
            "https://yandex.net:444/file.mp3",
            "https://127.0.0.1/file.mp3",
        ] {
            assert!(
                !is_allowed_media_url(&Url::parse(value).unwrap()),
                "{value}"
            );
        }
    }

    #[test]
    fn artwork_proxy_accepts_only_known_avatar_endpoints() {
        for value in [
            "https://avatars.yandex.net/get-music-content/123/400x400",
            "https://avatars.mds.yandex.net/get/400x400",
        ] {
            assert!(
                is_allowed_artwork_url(&Url::parse(value).unwrap()),
                "{value}"
            );
        }
        for value in [
            "https://storage.yandex.net/get-music-content/123/400x400",
            "https://avatars.yandex.net/unrelated/large-file",
            "https://avatars.yandex.net.evil.example/get/400x400",
            "http://avatars.yandex.net/get/400x400",
        ] {
            assert!(
                !is_allowed_artwork_url(&Url::parse(value).unwrap()),
                "{value}"
            );
        }
    }

    #[test]
    fn hmac_signature_matches_the_current_protocol() {
        assert_eq!(
            sign_file_info("12345", 1_700_000_000, "7tvSmFbyf5hJnIHhCimDDD"),
            "cIr27Nz/vx8itCxjo2MQwhi49eA5o8WpLN2GAbUCgW0"
        );
    }

    #[test]
    fn current_protocol_prefers_both_lossless_containers() {
        assert_eq!(&LOSSLESS_CODECS[..2], &["flac-mp4", "flac"]);
        assert!(
            LOSSLESS_CODECS[2..]
                .iter()
                .all(|codec| !codec.starts_with("flac"))
        );
    }

    #[test]
    fn account_status_requires_a_real_uid() {
        let valid: AccountStatusResult = serde_json::from_str(r#"{"account":{"uid":42}}"#).unwrap();
        assert_eq!(account_uid_from_status(valid).unwrap(), "42");

        let missing: AccountStatusResult = serde_json::from_str("{}").unwrap();
        assert_eq!(
            account_uid_from_status(missing).unwrap_err().status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn file_info_parser_accepts_snake_and_camel_case_wrappers() {
        for json in [
            r#"{"download_info":{"quality":"lossless","codec":"flac","urls":["https://x.yandex.net/a"],"key":"00112233445566778899aabbccddeeff","bitrate":1411}}"#,
            r#"{"result":{"downloadInfo":{"quality":"lossless","codec":"flac-mp4","urls":["https://x.yandex.net/b"],"bitrate":999}}}"#,
        ] {
            let info = parse_file_info(json.as_bytes()).unwrap();
            assert_eq!(info.quality.as_deref(), Some("lossless"));
            assert_eq!(info.urls.len(), 1);
            assert!(matches!(info.codec.as_str(), "flac" | "flac-mp4"));
        }
    }

    #[test]
    fn aes_ctr_decryption_supports_whole_and_range_responses() {
        let key = decode_aes_key("00112233445566778899aabbccddeeff").unwrap();
        let plaintext = b"fLaC encrypted payload with enough bytes for a range";
        let mut encrypted = plaintext.to_vec();
        AesCtrCipher::new(&key, 0)
            .unwrap()
            .apply(&mut encrypted)
            .unwrap();

        let mut whole = encrypted.clone();
        AesCtrCipher::new(&key, 0)
            .unwrap()
            .apply(&mut whole)
            .unwrap();
        assert_eq!(whole, plaintext);

        let offset = 13;
        let mut partial = encrypted[offset..].to_vec();
        AesCtrCipher::new(&key, offset as u64)
            .unwrap()
            .apply(&mut partial)
            .unwrap();
        assert_eq!(partial, plaintext[offset..]);
    }

    #[test]
    fn configured_cors_origin_rejects_missing_and_mismatched_api_origins() {
        let app = test_app(Some("https://music.example"));
        let missing = incoming(Method::GET, "/api/settings/status", None);
        assert_eq!(
            app.validate_browser_origin(&missing).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        let mismatched = incoming(
            Method::GET,
            "/api/settings/status",
            Some("https://attacker.example"),
        );
        assert_eq!(
            app.validate_browser_origin(&mismatched).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        let matching = incoming(
            Method::GET,
            "/api/settings/status",
            Some("https://music.example"),
        );
        assert!(app.validate_browser_origin(&matching).is_ok());
        assert!(
            app.validate_browser_origin(&incoming(Method::GET, "/healthz", None))
                .is_ok()
        );
    }

    #[test]
    fn public_request_base_honors_the_forwarded_development_scheme() {
        let app = test_app(None);
        let mut request = incoming(Method::GET, "/api/media/resolve/1", None);
        request
            .headers
            .insert(HOST, HeaderValue::from_static("localhost:5173"));
        request
            .headers
            .insert("x-forwarded-proto", HeaderValue::from_static("http"));
        assert_eq!(
            app.public_request_base(&request).unwrap().as_str(),
            "http://localhost:5173/"
        );
    }

    #[test]
    fn legacy_metadata_builds_a_signed_allowed_url() {
        let xml = "<root><host>storage.yandex.net</host><path>/a/b.mp3</path><ts>123</ts><s>secret</s></root>";
        let url = build_legacy_media_url(xml).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("storage.yandex.net"));
        assert!(url.path().starts_with("/get-mp3/"));
        assert!(url.path().ends_with("/123/a/b.mp3"));
    }

    #[test]
    fn legacy_metadata_rejects_non_yandex_hosts() {
        let xml = "<root><host>169.254.169.254</host><path>/meta</path><ts>1</ts><s>x</s></root>";
        assert_eq!(
            build_legacy_media_url(xml).unwrap_err(),
            "Download metadata returned an unsupported host"
        );
    }

    #[test]
    fn token_validation_trims_but_rejects_controls_and_short_values() {
        assert_eq!(
            validate_token("  abcdefgh  ".to_owned()).unwrap(),
            "abcdefgh"
        );
        assert!(validate_token("short".to_owned()).is_err());
        assert!(validate_token("valid-token\nother".to_owned()).is_err());
    }

    #[tokio::test]
    async fn stored_token_is_validated_before_use() {
        let mut app = test_app(None);
        app.secrets.token.environment = Some("  abcdefgh  ".to_owned());
        assert_eq!(app.required_token().await.unwrap(), "abcdefgh");

        app.secrets.token.environment = Some("short".to_owned());
        assert_eq!(
            app.required_token().await.unwrap_err().status,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn runtime_token_mutation_route_is_absent() {
        let app = test_app(None);
        let response = app
            .dispatch(incoming(Method::POST, "/api/settings/token", None))
            .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn secret_comparison_requires_equal_lengths_and_contents() {
        assert!(secret_eq(b"constant-secret", b"constant-secret"));
        assert!(!secret_eq(b"constant-secret", b"constant-secrex"));
        assert!(!secret_eq(b"constant-secret", b"constant-secret-longer"));
    }

    #[test]
    fn base64_artwork_source_round_trips_without_padding() {
        let value = "https://avatars.yandex.net/get-music-content/1/400x400?x=one&y=two";
        let encoded = URL_SAFE_NO_PAD.encode(value.as_bytes());
        let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        assert_eq!(decoded, value.as_bytes());
    }

    #[test]
    fn incremental_response_limit_rejects_before_appending_overflow() {
        let mut target = BytesMut::from(&b"123"[..]);
        append_limited(&mut target, b"45", 5).unwrap();
        assert_eq!(&target[..], b"12345");
        assert_eq!(
            append_limited(&mut target, b"6", 5).unwrap_err().status,
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(&target[..], b"12345");
    }

    fn incoming(method: Method, path: &str, origin: Option<&str>) -> IncomingRequest {
        let mut headers = HeaderMap::new();
        if let Some(origin) = origin {
            headers.insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        IncomingRequest {
            method,
            uri: path.parse().unwrap(),
            headers,
            body: Bytes::new(),
        }
    }

    fn test_app(allowed_origin: Option<&str>) -> App {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .unwrap();
        App {
            api_client: client.clone(),
            media_client: client,
            secrets: SecretStore {
                token: SecretLocator {
                    environment: None,
                    parameter: None,
                },
                signing_key: SecretLocator {
                    environment: None,
                    parameter: None,
                },
                cache_ttl: Duration::from_secs(300),
                cache: Mutex::new(HashMap::new()),
                ssm: OnceCell::new(),
            },
            api_origin: Url::parse(API_ORIGIN).unwrap(),
            allowed_origin: allowed_origin.map(|origin| HeaderValue::from_str(origin).unwrap()),
            origin_verify: None,
            public_base_url: None,
            http_addr: DEFAULT_HTTP_ADDR.parse().unwrap(),
            account_uid: Mutex::new(None),
        }
    }
}
