#pragma once
#include "http/httpfs_client.hpp"
#include <unordered_map>
#include <list>
#include <vector>

struct QueryNetwork {
    void *context;
    double deadline;
    uint64_t transfer_limit_bytes;
    uint32_t requests = 0;
    uint64_t bytes = 0;
    uint64_t full_read_bytes = 0;
    int32_t cache_block_bytes = 0; // -1 disabled, 0 exact ranges, positive aligned blocks
    uint32_t cache_hits = 0, cache_peak_bytes = 0, staging_peak_bytes = 0;
    int error = 0;
    std::string error_reason;
    uint32_t upstream_status = 0;
    uint32_t method = 0; // 0 unknown, 1 HEAD, 2 GET
    std::unordered_map<std::string, std::string> versions;
    std::unordered_map<std::string, uint64_t> sizes;
};
class WorkerHTTPUtil final : public duckdb::HTTPFSUtil {
public:
    explicit WorkerHTTPUtil(QueryNetwork &state) : state(state) {}
    duckdb::string GetName() const override { return "WasmHTTPUtils"; }
    duckdb::HTTPTransportReusePolicy GetTransportReusePolicy() const override {
        return duckdb::HTTPTransportReusePolicy::CLIENT_FREE;
    }
    duckdb::unique_ptr<duckdb::HTTPResponse> SendRequest(duckdb::BaseRequest &request,
        duckdb::unique_ptr<duckdb::HTTPClient> &client) override;
private:
    struct RangeEntry {
        std::string key;
        uint64_t start, total;
        duckdb::HTTPHeaders headers;
        std::vector<uint8_t> bytes;
        size_t charge;
    };
    std::list<RangeEntry> ranges;
    size_t cache_bytes = 0;
    QueryNetwork &state;
};
