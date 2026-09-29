mod api;
mod handler;

fn main() {
    handler::initialize();
}

#[worker::event(fetch)]
async fn fetch(
    req: worker::Request,
    env: worker::Env,
    _ctx: worker::Context,
) -> worker::Result<worker::Response> {
    handler::handle(req, env).await
}
