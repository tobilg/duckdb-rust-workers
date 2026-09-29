#include "worker_http_util.hpp"
#include "duckdb/common/string_util.hpp"
#include "http/httpfs.hpp"
#include <emscripten.h>
#include <algorithm>
#include <sstream>
#include <stdexcept>
#include <vector>
#include <map>

extern "C" int eval_url_allowed(void *, const char *, uint32_t);
extern "C" int eval_same_origin(const char *, uint32_t, const char *, uint32_t);

EM_ASYNC_JS(int, worker_fetch, (const char *url, const char *headers_json, int head, int ranged,
    uint8_t *body, uint32_t capacity, char *metadata, uint32_t metadata_capacity,
    uint32_t *received, uint32_t *upstream_status, char *failure_reason, int timeout_ms), {
    const address = UTF8ToString(url);
    const headers = new Headers(JSON.parse(UTF8ToString(headers_json)));
    // Production Workers otherwise negotiate compression automatically. File
    // offsets and strong validators must describe the unencoded representation.
    headers.set('Accept-Encoding', 'identity');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    let reader, count = 0, failure = '', phase = 'fetch';
    const fail = (reason, status = 502) => { failure = reason; return -status; };
    try {
        const response = await globalThis.fetch(address, { method: head ? 'HEAD' : 'GET', headers,
            redirect: 'manual', signal: controller.signal });
        HEAPU32[upstream_status >>> 2] = response.status;
        phase = 'body';
        let info = String(response.status) + '\n';
        for (const [key, value] of response.headers) {
            info += key.toLowerCase() + ':' + value + '\n';
            if (info.length > metadata_capacity) { if (response.body) await response.body.cancel(); return fail('response_headers_too_large'); }
        }
        const encoded = new TextEncoder().encode(info);
        if (encoded.length + 1 > metadata_capacity) { if (response.body) await response.body.cancel(); return fail('response_headers_too_large'); }
        HEAPU8.set(encoded, metadata); HEAPU8[metadata + encoded.length] = 0;
        // An ignored Range is retried once by httpfs as a bounded full snapshot.
        // Do not first buffer the entire ignored response into a range buffer.
        if (head || (ranged && response.status === 200) || (response.status !== 200 && response.status !== 206)) {
            if (response.body) await response.body.cancel();
            return 0;
        }
        const declared = response.headers.get('content-length');
        if (declared !== null && !/^[0-9]+$/.test(declared)) {
            if (response.body) await response.body.cancel(); return fail('invalid_content_length');
        }
        if (declared !== null && BigInt(declared) > BigInt(capacity)) {
            if (response.body) await response.body.cancel(); return fail('response_body_limit');
        }
        if (!response.body) return declared === '0' || declared === null ? 0 : fail('missing_response_body');
        reader = response.body.getReader();
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            count += value.length;
            if (count > capacity) { await reader.cancel(); return fail('response_body_limit'); }
            // Reacquire the current Wasm view after every await.
            HEAPU8.set(value, body + count - value.length);
        }
        if (declared !== null && BigInt(declared) !== BigInt(count)) return fail('content_length_mismatch');
        return count;
    } catch (error) {
        if (reader) { try { await reader.cancel(); } catch (_) {} }
        if (controller.signal.aborted) return fail('fetch_timeout', 504);
        return fail(phase + (error instanceof TypeError ? '_type_error' : '_failed'));
    } finally {
        HEAPU32[received >>> 2] = count;
        // Only fixed reason codes cross the bridge, never exception messages or
        // URLs. The native caller supplies 64 bytes; all codes fit within 63.
        const reason = new TextEncoder().encode(failure);
        HEAPU8.set(reason, failure_reason); HEAPU8[failure_reason + reason.length] = 0;
        clearTimeout(timer); controller.abort();
        if (reader) reader.releaseLock();
    }
});

namespace {
constexpr uint64_t FULL_READ_BUDGET = 4 * 1024 * 1024;
constexpr uint64_t CACHE_BUDGET = 4 * 1024 * 1024;
bool StrongETag(const std::string &etag) {
    if (etag.size() < 2 || etag.front() != '"' || etag.back() != '"') return false;
    for (size_t i = 1; i + 1 < etag.size(); ++i) {
        const auto c = static_cast<unsigned char>(etag[i]);
        if (c <= 0x20 || c == '"' || c == 0x7f) return false;
    }
    return true;
}
std::string Quote(const std::string &value) {
    std::string out = "\"";
    const char hex[] = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += c;
    }
    return out + '"';
}
uint64_t Number(const std::string &s) {
    if (s.empty() || s.find_first_not_of("0123456789") != std::string::npos)
        throw duckdb::IOException("invalid range number");
    try { return std::stoull(s); }
    catch (const std::exception &) { throw duckdb::IOException("range overflow"); }
}
}

duckdb::unique_ptr<duckdb::HTTPResponse> WorkerHTTPUtil::SendRequest(duckdb::BaseRequest &request,
    duckdb::unique_ptr<duckdb::HTTPClient> &) {
    using namespace duckdb;
    auto fail = [&](int status, const char *reason) -> void {
        state.error = status; state.error_reason = reason;
        throw IOException("Worker transport policy or upstream failure");
    };
    state.upstream_status = 0;
    state.method = request.type == RequestType::HEAD_REQUEST ? 1 :
                   request.type == RequestType::GET_REQUEST ? 2 : 0;
    state.error_reason.clear();
    if (!state.method) fail(502, "unsupported_http_method");
    const bool head = request.type == RequestType::HEAD_REQUEST;
    const bool range = !head && request.headers.HasHeader("Range");
    const bool full_read = !head && !range;
    uint64_t wanted_start = 0, wanted_end = 0;
    if (range) {
        const auto value = request.headers.GetHeaderValue("Range");
        const auto dash = value.find('-');
        if (value.rfind("bytes=",0) != 0 || dash == std::string::npos) fail(502,"invalid_request_range");
        wanted_start = Number(value.substr(6,dash-6)); wanted_end = Number(value.substr(dash+1));
        if (wanted_end < wanted_start || wanted_end-wanted_start >= 8*1024*1024) fail(502,"request_range_limit");
    }
    auto deliver = [&](HTTPResponse &response, const uint8_t *body, uint32_t length) {
        if (head) return;
        auto &get = request.Cast<GetRequestInfo>();
        if (get.response_handler && !get.response_handler(response)) return;
        if (get.content_handler) {
            if (length && !get.content_handler(body,length)) fail(502,"content_handler_rejected");
        } else response.body.assign(reinterpret_cast<const char *>(body),length);
    };
    auto slice_headers = [](HTTPResponse &response, uint64_t start, uint64_t end, uint64_t total) {
        response.headers["content-length"] = std::to_string(end-start+1);
        response.headers["content-range"] = "bytes " + std::to_string(start) + "-" + std::to_string(end) + "/" + std::to_string(total);
    };
    std::string address = request.url;
    for (unsigned redirects = 0; redirects < 3; ++redirects) {
        state.upstream_status = 0;
        if (!eval_url_allowed(state.context,address.data(),address.size())) fail(502,"source_policy");
        const auto remaining_ms = state.deadline-emscripten_get_now();
        if (remaining_ms <= 0) fail(504,"query_io_deadline");
        const bool same_origin = eval_same_origin(request.url.data(),request.url.size(),address.data(),address.size());
        std::map<std::string,std::string> effective;
        bool can_widen = address.find('?') == std::string::npos;
        for (const auto &h : request.headers) {
            const auto name = StringUtil::Lower(h.first);
            // Credentials stay on their original origin, including signed headers.
            const bool benign = name=="range" || name=="accept" || name=="accept-encoding" ||
                name=="if-match" || name=="if-none-match" || name=="if-modified-since" || name=="if-unmodified-since";
            if (!same_origin && !benign) continue;
            if (!benign && name!="user-agent") can_widen = false;
            effective[name] = h.second;
        }
        // Cache identity includes the URL and every effective request header,
        // including credentials and read conditions. Only Range is excluded.
        std::string key = Quote(address);
        for (const auto &h : effective) if (h.first!="range") key += Quote(h.first)+Quote(h.second);
        if (range && state.cache_block_bytes >= 0) {
            for (auto it=ranges.begin(); it!=ranges.end(); ++it) {
                const auto end = std::min(wanted_end,it->total-1);
                if (it->key!=key || wanted_start < it->start || end < wanted_start ||
                    end-it->start >= it->bytes.size()) continue;
                auto response = make_uniq<HTTPResponse>(HTTPStatusCode::PartialContent_206);
                response->url = address; response->headers = it->headers;
                slice_headers(*response,wanted_start,end,it->total);
                ++state.cache_hits; state.upstream_status = 206;
                deliver(*response,it->bytes.data()+wanted_start-it->start,end-wanted_start+1);
                ranges.splice(ranges.begin(),ranges,it);
                return response;
            }
        }
        if (state.bytes >= state.transfer_limit_bytes) fail(502,"query_transfer_limit");
        const auto transfer_remaining = state.transfer_limit_bytes-state.bytes;
        const auto full_remaining = FULL_READ_BUDGET-std::min(FULL_READ_BUDGET,state.full_read_bytes);
        if (full_read && !full_remaining) fail(502,"full_download_limit");
        uint64_t start = wanted_start, end = wanted_end;
        const auto known_size = state.sizes.find(address);
        if (range && can_widen && state.cache_block_bytes > 0 && known_size!=state.sizes.end() &&
            end < known_size->second && end-start+1 <= static_cast<uint64_t>(state.cache_block_bytes)) {
            const auto block = static_cast<uint64_t>(state.cache_block_bytes);
            start = start/block*block;
            // Add only the remaining bytes in this block/object; multiplication
            // to round up could overflow for large 64-bit object offsets.
            end += std::min(block-1-end%block,known_size->second-1-end);
        }
        if (range) effective["range"] = "bytes="+std::to_string(start)+"-"+std::to_string(end);
        std::string headers = "{";
        for (const auto &h : effective) {
            if (headers.size()>1) headers += ',';
            headers += Quote(h.first)+':'+Quote(h.second);
        }
        headers += '}';
        uint32_t cap = 8*1024*1024;
        if (range) cap = std::min<uint64_t>(cap,end-start+1);
        if (full_read) {
            cap = std::min<uint64_t>(cap,full_remaining);
            if (known_size!=state.sizes.end()) cap = std::min<uint64_t>(cap,known_size->second);
        }
        const bool transfer_limited = transfer_remaining < cap;
        cap = std::min<uint64_t>(cap,transfer_remaining);
        std::vector<uint8_t> body(head ? 1 : std::max(1u,cap));
        state.staging_peak_bytes = std::max<uint32_t>(state.staging_peak_bytes,body.size());
        char metadata[16384] = {}, failure_reason[64] = {};
        uint32_t received = 0;
        ++state.requests;
        const int length = worker_fetch(address.c_str(),headers.c_str(),head,range,body.data(),cap,
            metadata,sizeof(metadata),&received,&state.upstream_status,failure_reason,
            std::min(10000,static_cast<int>(remaining_ms)));
        state.bytes += received; request.bytes_received += received;
        if (full_read) state.full_read_bytes += received;
        if (length < 0) {
            if (std::string(failure_reason)=="response_body_limit") {
                if (transfer_limited) fail(502,"query_transfer_limit");
                if (full_read) fail(502,"full_download_limit");
            }
            fail(-length,failure_reason[0] ? failure_reason : "host_fetch_failed");
        }
        std::istringstream lines(metadata);
        std::string line;
        if (!std::getline(lines,line)) fail(502,"invalid_response_metadata");
        const auto status = Number(line);
        auto response = make_uniq<HTTPResponse>(HTTPUtil::ToStatusCode(status));
        response->url = address;
        while (std::getline(lines,line)) {
            const auto colon = line.find(':');
            if (colon==std::string::npos) fail(502,"invalid_response_metadata");
            response->headers.Append(line.substr(0,colon),line.substr(colon+1));
        }
        if (status>=300 && status<=399) {
            if (!response->HasHeader("location")) fail(502,"missing_redirect_location");
            const auto location = response->GetHeaderValue("location");
            if (redirects==2) fail(502,"redirect_limit");
            if (!eval_url_allowed(state.context,location.data(),location.size())) fail(502,"redirect_policy");
            address = location; continue;
        }
        if (status==412) fail(502,"object_changed");
        if (status!=200 && status!=206) state.error_reason = "upstream_http_status";
        uint64_t total = 0;
        if (status==200 || status==206) {
            const auto etag = response->HasHeader("etag") ? response->GetHeaderValue("etag") : "";
            if (!StrongETag(etag)) {
                if (range && status==206) fail(502,etag.empty() ? "missing_etag" : "weak_etag");
                if (head && response->HasHeader("content-length") && Number(response->GetHeaderValue("content-length"))>full_remaining)
                    fail(502,"full_download_limit");
            }
            const auto found = state.versions.find(address);
            if (found!=state.versions.end() && found->second!=etag) fail(502,"object_changed");
            if (!etag.empty()) state.versions.emplace(address,etag);
            if ((head || status==200) && response->HasHeader("content-length")) {
                total = Number(response->GetHeaderValue("content-length"));
                auto old = state.sizes.find(address);
                if (old!=state.sizes.end() && old->second!=total) fail(502,"object_changed");
                state.sizes[address] = total;
            }
            if (range && status==200) {
                const auto size = state.sizes.find(address);
                if (size!=state.sizes.end() && size->second>full_remaining) fail(502,"full_download_limit");
                // Preserve httpfs's state machine and conditional full-download
                // validation. Only an ignored Range selects this fallback.
                try { RangeRequestNotSupportedException::Throw(); }
                catch (const std::exception &ex) { response->request_error=ex.what(); response->success=false; }
                return response;
            }
            if (range) {
                if (!response->HasHeader("content-range")) fail(502,"missing_content_range");
                const auto actual = response->GetHeaderValue("content-range");
                const auto sep = actual.find('-'), slash = actual.find('/');
                if (actual.rfind("bytes ",0)!=0 || sep==std::string::npos || slash==std::string::npos || sep>=slash) fail(502,"invalid_content_range");
                const auto actual_start = Number(actual.substr(6,sep-6));
                const auto actual_end = Number(actual.substr(sep+1,slash-sep-1));
                total = Number(actual.substr(slash+1));
                if (actual_start!=start || actual_end<start || actual_end>=total ||
                    actual_end!=std::min(end,total-1) || actual_end-start+1!=static_cast<uint64_t>(length) || wanted_start>actual_end)
                    fail(502,"invalid_content_range");
                const auto old = state.sizes.find(address);
                if (old!=state.sizes.end() && old->second!=total) fail(502,"object_changed");
                state.sizes[address] = total;
                end = actual_end;
            }
        }
        if (range && status==206) {
            // Keep original response metadata for reuse; expose exactly the
            // requested slice to httpfs even when the wire range was widened.
            const auto wire_headers = response->headers;
            const auto wanted_last = std::min(wanted_end,end);
            slice_headers(*response,wanted_start,wanted_last,total);
            deliver(*response,body.data()+wanted_start-start,wanted_last-wanted_start+1);
            // Charge conservatively for strings, both HTTPHeaders maps, list
            // nodes and allocator overhead as well as the retained byte buffer.
            const auto fields = std::distance(wire_headers.begin(),wire_headers.end());
            const size_t charge = body.capacity()+key.capacity()+3*std::char_traits<char>::length(metadata)+
                fields*256+sizeof(RangeEntry)+128;
            if (state.cache_block_bytes>=0 && charge<=CACHE_BUDGET) {
                while (!ranges.empty() && (cache_bytes+charge>CACHE_BUDGET || ranges.size()>=64)) {
                    cache_bytes -= ranges.back().charge; ranges.pop_back();
                }
                body.resize(length);
                ranges.push_front({std::move(key),start,total,wire_headers,std::move(body),charge});
                cache_bytes += charge;
                state.cache_peak_bytes = std::max<uint32_t>(state.cache_peak_bytes,cache_bytes);
            }
        } else deliver(*response,body.data(),length);
        return response;
    }
    fail(502,"redirect_limit");
    return nullptr;
}
