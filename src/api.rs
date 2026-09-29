use futures_util::StreamExt;
use serde::Deserialize;
use std::{
    ffi::CString,
    io::{self, Write},
    slice, str,
};
use wasm_bindgen::prelude::*;
use worker::*;

const OUTPUT: usize = 1024 * 1024 - 4096;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    sql: String,
    #[serde(default)]
    params: Vec<serde_json::Value>,
    max_rows: Option<u32>,
}
struct Parameter {
    kind: i32,
    data: String,
}
#[derive(serde::Serialize)]
struct NetworkDiagnostic {
    reason: String,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_status: Option<u16>,
}
pub struct QueryContext {
    params: Vec<Parameter>,
    allowed_origin: Option<url::Origin>,
    prefix: String,
    output: Vec<u8>,
    max_rows: Option<u32>,
    rows: u32,
    columns: u32,
    cells: u32,
    truncated: bool,
    error: u16,
    fetch_count: u32,
    fetch_bytes: u64,
    cache_hits: u32,
    cache_peak_bytes: u32,
    staging_peak_bytes: u32,
    transfer_limit_bytes: u64,
    tuning: [i32; 2],
    network_diagnostic: Option<NetworkDiagnostic>,
}
struct Budget<'a>(&'a mut Vec<u8>);
impl Write for Budget<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > OUTPUT.saturating_sub(self.0.len()) {
            return Err(io::Error::other("output limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl QueryContext {
    fn append(&mut self, bytes: &[u8]) -> bool {
        if Budget(&mut self.output).write_all(bytes).is_err() {
            self.error = 413;
            return false;
        }
        true
    }
    fn json<T: serde::Serialize + ?Sized>(&mut self, value: &T) -> bool {
        if serde_json::to_writer(Budget(&mut self.output), value).is_err() {
            self.error = 413;
            return false;
        }
        true
    }
    fn allows(&self, address: &str) -> bool {
        url::Url::parse(address).is_ok_and(|u| {
            u.scheme() == "https"
                && self
                    .allowed_origin
                    .as_ref()
                    .is_none_or(|origin| u.origin() == *origin)
                && u.username().is_empty()
                && u.password().is_none()
                && u.fragment().is_none()
                && u.path().starts_with(&self.prefix)
        })
    }
}
#[wasm_bindgen(
    inline_js = "export function invokeQuery(ctx, sql) { return globalThis[Symbol.for('duckdb.eval.query')](ctx, sql); }"
)]
extern "C" {
    #[wasm_bindgen(catch, js_name = invokeQuery)]
    async fn invoke_query(ctx: u32, sql: u32) -> std::result::Result<JsValue, JsValue>;
}
pub fn error(id: u32, status: u16) -> Result<Response> {
    error_with_context(id, status, None)
}
fn error_with_context(id: u32, status: u16, context: Option<&QueryContext>) -> Result<Response> {
    let (category, message) = match status {
        401 => ("authentication", "Evaluation authentication required"),
        403 => ("authentication", "Evaluation access denied"),
        429 => ("busy", "One query is already active"),
        413 => (
            "output_limit",
            "Serialized result exceeds the output budget",
        ),
        502 => (
            "upstream",
            "Remote read failed or violated source/transfer policy",
        ),
        504 => ("io_deadline", "Remote read deadline exceeded"),
        500 => ("internal", "Engine or module failure"),
        _ => (
            "input_sql",
            "Invalid input, unsupported result type, or rejected SQL",
        ),
    };
    let mut body =
        serde_json::json!({"request_id":id,"error":{"category":category,"message":message}});
    if let Some(context) = context.filter(|_| status == 502 || status == 504) {
        if let Some(diagnostic) = &context.network_diagnostic {
            body["error"]["diagnostic"] = serde_json::to_value(diagnostic)?;
        }
        body["metrics"] = serde_json::json!({
            "fetch_count": context.fetch_count,
            "fetch_bytes": context.fetch_bytes,
            "cache_hits": context.cache_hits,
            "cache_peak_bytes": context.cache_peak_bytes,
            "staging_peak_bytes": context.staging_peak_bytes,
        });
    }
    Response::from_json(&body).map(|r| r.with_status(status))
}
pub async fn query(mut req: Request, env: Env, id: u32) -> Result<Response> {
    if let Ok(api_key) = env.secret("API_KEY") {
        let expected = format!("Bearer {}", api_key);
        let received = req.headers().get("Authorization")?.unwrap_or_default();
        let mismatch = expected
            .bytes()
            .zip(received.bytes())
            .fold(0u8, |v, (a, b)| v | (a ^ b));
        if received.len() != expected.len() || mismatch != 0 {
            return error(id, 403);
        }
    } else if env
        .var("LOCAL_EVALUATION")
        .ok()
        .map(|v| v.to_string())
        .as_deref()
        != Some("1")
    {
        return error(id, 401);
    }
    let start = js_sys::Date::now();
    let mut body = Vec::new();
    let mut stream = req.stream()?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > 65536 {
            return error(id, 400);
        }
        body.extend_from_slice(&chunk);
    }
    let input: Input = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error(id, 400),
    };
    let max_rows = input.max_rows;
    if max_rows.is_some_and(|limit| limit == 0 || limit > 10000) || input.params.len() > 256 {
        return error(id, 400);
    }
    let sql = match CString::new(input.sql) {
        Ok(s) => s,
        Err(_) => return error(id, 400),
    };
    let allowed_origin = match env.var("ALLOWED_ORIGIN") {
        Ok(value) => match url::Url::parse(&value.to_string()) {
            Ok(u) if u.scheme() == "https" && u.username().is_empty() && u.password().is_none() => {
                Some(u.origin())
            }
            _ => return error(id, 500),
        },
        Err(_) => None,
    };
    let prefix = env
        .var("ALLOWED_PATH_PREFIX")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "/".into());
    if !prefix.starts_with('/') {
        return error(id, 500);
    }
    let mut params = Vec::new();
    for value in input.params {
        let (kind, data) = match value {
            serde_json::Value::Null => (0, String::new()),
            serde_json::Value::Bool(b) => (1, b.to_string()),
            serde_json::Value::String(s) => (2, s),
            serde_json::Value::Number(n) => (
                if n.is_i64() {
                    3
                } else if n.is_u64() {
                    4
                } else {
                    5
                },
                n.to_string(),
            ),
            _ => return error(id, 400),
        };
        params.push(Parameter { kind, data });
    }
    // Trusted deployment settings only; clients cannot increase resource budgets.
    let transfer_setting =
        js_sys::Reflect::get(&env, &JsValue::from_str("QUERY_TRANSFER_LIMIT_MIB"))?;
    let transfer_limit_mib = if transfer_setting.is_undefined() {
        64
    } else {
        match transfer_setting
            .as_string()
            .and_then(|value| value.parse::<u32>().ok())
        {
            Some(value) if value > 0 => value,
            _ => return error(id, 500),
        }
    };
    // -1 disables the range cache / selects DuckDB's adaptive column gap.
    let mut tuning = [0, 65536];
    for (index, name) in ["RANGE_CACHE_BLOCK_BYTES", "PARQUET_PREFETCH_COLUMN_GAP"]
        .iter()
        .enumerate()
    {
        if let Ok(value) = env.var(name) {
            let Ok(value) = value.to_string().parse::<i32>() else {
                return error(id, 500);
            };
            if !(-1..=1048576).contains(&value) {
                return error(id, 500);
            }
            tuning[index] = value;
        }
    }
    let mut context = Box::new(QueryContext {
        params,
        allowed_origin,
        prefix,
        output: b"{\"columns\":[".to_vec(),
        max_rows,
        rows: 0,
        columns: 0,
        cells: 0,
        truncated: false,
        error: 0,
        fetch_count: 0,
        fetch_bytes: 0,
        cache_hits: 0,
        cache_peak_bytes: 0,
        staging_peak_bytes: 0,
        transfer_limit_bytes: u64::from(transfer_limit_mib) * 1024 * 1024,
        tuning,
        network_diagnostic: None,
    });
    let pointer = (&mut *context as *mut QueryContext) as u32;
    let result = invoke_query(pointer, sql.as_ptr() as u32).await;
    if result.is_err() {
        crate::handler::mark_fatal();
        return error(id, 500);
    }
    let status = result.unwrap().as_f64().unwrap_or(500.0) as u16;
    if context.error != 0 {
        return error(id, context.error);
    }
    if status != 0 {
        if status == 500 {
            crate::handler::mark_fatal();
        }
        return error_with_context(id, status, Some(&context));
    }
    // Reserve in OUTPUT leaves room for this fixed-size trailer.
    let trailer = format!("],\"truncated\":{},\"request_id\":{},\"metrics\":{{\"wall_ms\":{},\"fetch_count\":{},\"fetch_bytes\":{},\"cache_hits\":{},\"cache_peak_bytes\":{},\"staging_peak_bytes\":{}}}}}",
        context.truncated,id,js_sys::Date::now()-start,context.fetch_count,context.fetch_bytes,
        context.cache_hits,context.cache_peak_bytes,context.staging_peak_bytes);
    context.output.extend_from_slice(trailer.as_bytes());
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    Response::from_bytes(context.output).map(|r| r.with_headers(headers))
}

// These callbacks borrow the boxed context only for the duration of each call.
// The owning Rust future keeps it alive; no borrow crosses native suspension.
unsafe fn context<'a>(p: *mut QueryContext) -> &'a mut QueryContext {
    &mut *p
}
unsafe fn text<'a>(p: *const u8, n: u32) -> Option<&'a str> {
    str::from_utf8(slice::from_raw_parts(p, n as usize)).ok()
}
#[no_mangle]
pub unsafe extern "C" fn eval_param(
    p: *mut QueryContext,
    index: u32,
    kind: *mut i32,
    data: *mut *const u8,
    len: *mut u32,
) -> i32 {
    let Some(v) = context(p).params.get(index as usize) else {
        return 0;
    };
    *kind = v.kind;
    *data = v.data.as_ptr();
    *len = v.data.len() as u32;
    1
}
#[no_mangle]
pub unsafe extern "C" fn eval_url_allowed(p: *mut QueryContext, data: *const u8, len: u32) -> i32 {
    text(data, len).is_some_and(|s| context(p).allows(s)) as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_same_origin(
    first: *const u8,
    first_len: u32,
    second: *const u8,
    second_len: u32,
) -> i32 {
    let first = text(first, first_len).and_then(|s| url::Url::parse(s).ok());
    let second = text(second, second_len).and_then(|s| url::Url::parse(s).ok());
    matches!((first, second), (Some(a), Some(b)) if a.origin() == b.origin()) as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_statement_allowed(
    _p: *mut QueryContext,
    kind: i32,
    readonly: i32,
) -> i32 {
    // Native passes normalized SELECT=1 / ATTACH=2 only after parsing exactly one statement.
    ((kind == 1 && readonly != 0) || kind == 2) as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_column(
    p: *mut QueryContext,
    name: *const u8,
    n: u32,
    ty: *const u8,
    t: u32,
) -> i32 {
    let c = context(p);
    if c.columns >= 256 || n as usize + t as usize > OUTPUT.saturating_sub(c.output.len()) {
        c.error = 413;
        return 0;
    }
    let (Some(name), Some(ty)) = (text(name, n), text(ty, t)) else {
        c.error = 400;
        return 0;
    };
    if c.columns > 0 && !c.append(b",") {
        return 0;
    }
    if !c.json(&serde_json::json!({"name":name,"duckdb_type":ty})) {
        return 0;
    }
    c.columns += 1;
    1
}
#[no_mangle]
pub unsafe extern "C" fn eval_begin_rows(p: *mut QueryContext) -> i32 {
    context(p).append(b"],\"rows\":[") as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_row_begin(p: *mut QueryContext) -> i32 {
    let c = context(p);
    if c.max_rows.is_some_and(|limit| c.rows >= limit) {
        c.truncated = true;
        return 0;
    }
    c.cells = 0;
    if c.rows > 0 && !c.append(b",") {
        return 0;
    }
    c.append(b"[") as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_cell(
    p: *mut QueryContext,
    kind: i32,
    data: *const u8,
    len: u32,
) -> i32 {
    let c = context(p);
    if len as usize > OUTPUT.saturating_sub(c.output.len()) {
        c.error = 413;
        return 0;
    }
    let Some(s) = text(data, len) else {
        c.error = 400;
        return 0;
    };
    if c.cells > 0 && !c.append(b",") {
        return 0;
    }
    let ok = match kind {
        0 => c.append(b"null"),
        1 => c.append(if s == "true" { b"true" } else { b"false" }),
        2 => match s.parse::<i128>() {
            Ok(n) if (-9007199254740991..=9007199254740991).contains(&n) => c.append(s.as_bytes()),
            _ => c.json(s),
        },
        3 => c.json(s),
        4 => match s.parse::<f64>() {
            Ok(n) if n.is_finite() => c.json(&n),
            Ok(n) if n.is_nan() => c.json("NaN"),
            Ok(n) => c.json(if n.is_sign_positive() {
                "Infinity"
            } else {
                "-Infinity"
            }),
            Err(_) => {
                c.error = 400;
                false
            }
        },
        _ => {
            c.error = 400;
            false
        }
    };
    c.cells += 1;
    ok as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_row_end(p: *mut QueryContext) -> i32 {
    let c = context(p);
    c.rows += 1;
    c.append(b"]") as i32
}
#[no_mangle]
pub unsafe extern "C" fn eval_transfer_limit(p: *mut QueryContext) -> u64 {
    context(p).transfer_limit_bytes
}
#[no_mangle]
pub unsafe extern "C" fn eval_tuning(p: *mut QueryContext, index: u32) -> i32 {
    context(p).tuning.get(index as usize).copied().unwrap_or(-1)
}
#[no_mangle]
pub unsafe extern "C" fn eval_metrics(
    p: *mut QueryContext,
    count: u32,
    bytes: u64,
    hits: u32,
    cache: u32,
    staging: u32,
) {
    let c = context(p);
    c.fetch_count = count;
    c.fetch_bytes = bytes;
    c.cache_hits = hits;
    c.cache_peak_bytes = cache;
    c.staging_peak_bytes = staging;
}
#[no_mangle]
pub unsafe extern "C" fn eval_network_error(
    p: *mut QueryContext,
    reason: *const u8,
    len: u32,
    method: u32,
    upstream_status: u32,
) {
    // Native/host code supplies bounded reason tokens, never raw upstream data.
    let reason = (len <= 63)
        .then(|| text(reason, len))
        .flatten()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        .unwrap_or("unclassified_transport_error");
    context(p).network_diagnostic = Some(NetworkDiagnostic {
        reason: reason.into(),
        method: match method {
            1 => "HEAD",
            2 => "GET",
            _ => "unknown",
        },
        upstream_status: (100..=599)
            .contains(&upstream_status)
            .then_some(upstream_status as u16),
    });
}
