#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif
// Install the generated promising entry; request state stays in Rust/C++.
void query_install(void);
uint32_t bridge_memory_bytes(void);
// The context is an opaque, request-owned Rust allocation. All native errors
// become HTTP status codes (zero means success); exceptions never enter Rust.
int bridge_run(void *context, const char *sql)
#ifdef __cplusplus
    noexcept
#endif
    ;
#ifdef __cplusplus
}
#endif
