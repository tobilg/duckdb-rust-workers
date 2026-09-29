use std::cell::Cell;
use worker::*;

thread_local! {
    static BUSY: Cell<bool> = const { Cell::new(false) };
    static FATAL: Cell<bool> = const { Cell::new(false) };
    static REQUESTS: Cell<u32> = const { Cell::new(0) };
}

extern "C" {
    fn query_install();
    fn bridge_memory_bytes() -> u32;
}

pub fn initialize() {
    unsafe { query_install() }
}

pub fn mark_fatal() {
    FATAL.set(true);
}

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.set(false);
    }
}

pub async fn handle(req: Request, env: Env) -> Result<Response> {
    let id = REQUESTS.get().wrapping_add(1);
    REQUESTS.set(id);
    match (req.method(), req.path().as_str()) {
        (Method::Get, "/healthz") => Response::from_json(&serde_json::json!({
            "busy": BUSY.get(), "fatal": FATAL.get(), "request_id": id,
            "wasm_memory_bytes": unsafe { bridge_memory_bytes() }
        })),
        (Method::Post, "/v1/query") => {
            if FATAL.get() {
                return crate::api::error(id, 500);
            }
            if BUSY.replace(true) {
                return crate::api::error(id, 429);
            }
            let _guard = BusyGuard;
            crate::api::query(req, env, id).await
        }
        _ => Response::error("Not found", 404),
    }
}
