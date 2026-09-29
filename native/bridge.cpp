#include "bridge.h"
#include "duckdb.hpp"
#include <emscripten.h>
#include <emscripten/heap.h>
#include <stdexcept>
#include "worker_http_util.hpp"
#include "duckdb/main/query_result_stream.hpp"
#include "duckdb/parser/statement/attach_statement.hpp"
#include "duckdb/parser/expression/constant_expression.hpp"

extern "C" int32_t duckdb_register_static_extensions(void);

namespace {
void Register() {
    static bool registered = false;
    if (!registered) {
        if (duckdb_register_static_extensions() != 0) throw std::runtime_error("static registration failed");
        registered = true;
    }
}
}

extern "C" uint32_t bridge_memory_bytes(void) {
    return emscripten_get_heap_size();
}

extern "C" {
int eval_param(void *, uint32_t, int *, const char **, uint32_t *);
int eval_statement_allowed(void *, int, int);
int eval_column(void *, const char *, uint32_t, const char *, uint32_t);
int eval_begin_rows(void *);
int eval_row_begin(void *);
int eval_cell(void *, int, const char *, uint32_t);
int eval_row_end(void *);
void eval_metrics(void *, uint32_t, uint64_t);
void eval_network_error(void *, const char *, uint32_t, uint32_t, uint32_t);
}

namespace {
int CellKind(const duckdb::LogicalType &type) {
    using T = duckdb::LogicalTypeId;
    switch (type.id()) {
    case T::SQLNULL: return 0;
    case T::BOOLEAN: return 1;
    case T::TINYINT: case T::SMALLINT: case T::INTEGER: case T::BIGINT:
    case T::UTINYINT: case T::USMALLINT: case T::UINTEGER: case T::UBIGINT:
    case T::HUGEINT: case T::UHUGEINT: return 2;
    case T::VARCHAR: case T::CHAR: case T::DECIMAL: case T::DATE: case T::TIME:
    case T::TIMESTAMP: case T::TIMESTAMP_SEC: case T::TIMESTAMP_MS: case T::TIMESTAMP_NS:
    case T::TIMESTAMP_TZ: case T::TIMESTAMP_TZ_NS: return 3;
    case T::FLOAT: case T::DOUBLE: return 4;
    default: return -1;
    }
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int bridge_run(void *context, const char *sql) noexcept {
    using namespace duckdb;
    QueryNetwork network {context, emscripten_get_now() + 30000};
    struct Metrics {
        QueryNetwork &n;
        ~Metrics() {
            eval_metrics(n.context,n.requests,n.bytes);
            if (!n.error_reason.empty())
                eval_network_error(n.context,n.error_reason.data(),n.error_reason.size(),n.method,n.upstream_status);
        }
    } metrics {network};
    try {
        Register();
        DBConfig config;
        config.options.maximum_threads = 1;
        config.options.async_threads = 0;
        config.options.maximum_memory = 48 * 1024 * 1024;
        config.options.use_temporary_directory = false;
        config.options.temporary_directory = "";
        config.options.maximum_swap_space = 0;
        config.options.load_extensions = false;
        auto provider = make_shared_ptr<WorkerHTTPUtil>(network);
        DuckDB database(nullptr, &config);
        // This revision's DatabaseInstance::Configure does not transfer the HTTP
        // manager from DBConfig. Install on the live instance before LOAD/http I/O.
        database.instance->config.SetHTTPUtil(provider);
        Connection connection(database);
        for (const auto *extension : {"core_functions","parquet","json","httpfs"}) {
            auto loaded = connection.Query(std::string("LOAD ") + extension);
            if (loaded->HasError()) loaded->ThrowError();
            if (!database.instance->ExtensionIsLoaded(extension)) return 500;
        }
        if (&database.instance->config.GetHTTPUtil() != provider.get()) return 500;
        auto settings = connection.Query("SET http_retries=0; SET http_timeout=10; SET auto_fallback_to_full_download=false; SET force_download=false; SET force_download_without_strong_etag=true; SET enable_external_file_cache=false; SET max_execution_time=30000;");
        for (auto *r=settings.get(); r; r=r->next.get()) if (r->HasError()) r->ThrowError();
        auto parsed = connection.ExtractStatements(sql);
        if (parsed.size() != 1) return 400;
        const bool attach = parsed[0]->type == StatementType::ATTACH_STATEMENT;
        const int kind = parsed[0]->type == StatementType::SELECT_STATEMENT ? 1 : attach ? 2 : 0;
        if (!eval_statement_allowed(context,kind,1)) return 400;
        if (attach) {
            // Rust authorizes ATTACH only with the bridge's forced read-only configuration.
            parsed[0]->Cast<AttachStatement>().info->parsed_options["read_only"] = ConstantExpression::Boolean(true);
        }
        auto prepared = connection.Prepare(std::move(parsed[0]));
        if (prepared->HasError()) prepared->GetErrorObject().Throw();
        if (!eval_statement_allowed(context,kind,prepared->GetStatementProperties().modified_databases.empty())) return 400;
        vector<Value> parameters;
        for (uint32_t i=0;;++i) {
            int type; const char *data; uint32_t length;
            if (!eval_param(context,i,&type,&data,&length)) break;
            string value(data,length);
            switch(type) {
            case 0: parameters.emplace_back(); break;
            case 1: parameters.emplace_back(value == "true"); break;
            case 2: parameters.emplace_back(value); break;
            case 3: parameters.push_back(Value::BIGINT(std::stoll(value))); break;
            case 4: parameters.push_back(Value::UBIGINT(std::stoull(value))); break;
            case 5: parameters.push_back(Value::DOUBLE(std::stod(value))); break;
            default: return 400;
            }
        }
        auto result = prepared->Submit(parameters);
        if (result->HasError()) result->ThrowError();
        if (attach) {
            result->Complete();
            if (result->HasError()) result->ThrowError();
            eval_begin_rows(context);
            return 0;
        }
        QueryResultStream stream(std::move(result));
        for (idx_t col=0; col<stream.ColumnCount();++col) {
            if (CellKind(stream.GetTypes()[col]) < 0) return 400;
            const auto &name = stream.ColumnName(col).GetIdentifierName();
            const auto type = stream.GetTypes()[col].ToString();
            if (!eval_column(context,name.data(),name.size(),type.data(),type.size())) return 413;
        }
        if (!eval_begin_rows(context)) return 413;
        while (auto chunk = stream.Fetch()) {
            for (idx_t row=0; row<chunk->size();++row) {
                if (!eval_row_begin(context)) return 0;
                for (idx_t col=0; col<chunk->ColumnCount();++col) {
                    const auto value = chunk->GetValue(col,row);
                    const auto text = value.IsNull() ? "" : value.ToString();
                    const int cell_kind = value.IsNull() ? 0 : CellKind(value.type());
                    if (!eval_cell(context,cell_kind,text.data(),text.size())) return 400;
                }
                if (!eval_row_end(context)) return 413;
            }
        }
        if (stream.HasError()) stream.GetErrorObject().Throw();
        return 0;
    } catch (const std::bad_alloc &) {
        return 500;
    } catch (const std::exception &error) {
        if (network.error) return network.error;
        const ErrorData data(error);
        if (data.Type() == ExceptionType::HTTP || data.Type() == ExceptionType::IO) {
            if (network.error_reason.empty())
                network.error_reason = data.Type() == ExceptionType::HTTP ? "duckdb_http_error" : "duckdb_io_error";
            return 502;
        }
        if (data.Type() == ExceptionType::INTERNAL || data.Type() == ExceptionType::FATAL) return 500;
        return 400;
    } catch (...) { return 500; }
}

EM_JS(void, query_install, (), {
    globalThis[Symbol.for('duckdb.eval.query')] = (context, sql) => _bridge_run(context, sql);
});
