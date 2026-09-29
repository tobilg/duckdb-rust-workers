#pragma once
#include "http/httpfs_client.hpp"
#include <unordered_map>

struct QueryNetwork {
    void *context;
    double deadline;
    uint32_t requests = 0;
    uint64_t bytes = 0;
    uint64_t full_read_bytes = 0;
    int error = 0;
    std::string error_reason;
    uint32_t upstream_status = 0;
    uint32_t method = 0; // 0 unknown, 1 HEAD, 2 GET
    std::unordered_map<std::string, std::string> versions;
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
    QueryNetwork &state;
};
