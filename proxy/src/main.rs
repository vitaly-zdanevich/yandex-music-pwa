#![recursion_limit = "256"]

use std::convert::Infallible;
use std::sync::Arc;

use lambda_http::{Error, run_with_streaming_response, service_fn};
use yandex_music_proxy::App;

#[tokio::main]
async fn main() -> Result<(), Error> {
    let app = Arc::new(App::from_env()?);

    if App::should_self_host() {
        return app.run_http_server().await;
    }

    run_with_streaming_response(service_fn(move |request| {
        let app = Arc::clone(&app);
        async move { Ok::<_, Infallible>(app.handle_lambda(request).await) }
    }))
    .await
}
