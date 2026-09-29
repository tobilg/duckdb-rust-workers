use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=EMSCRIPTEN");
    println!("cargo:rerun-if-changed=native/bridge.h");
    println!("cargo:rerun-if-changed=native/worker_http_util.hpp");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let emscripten = PathBuf::from(env::var_os("EMSCRIPTEN").expect("source scripts/env.sh"));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for (source, object_name, cxx) in [
        ("native/bridge.cpp", "bridge.o", true),
        ("native/worker_http_util.cpp", "http.o", true),
        (
            "build/generated/static_extension_loader.c",
            "static_loader.o",
            false,
        ),
    ] {
        println!("cargo:rerun-if-changed={source}");
        let object = out.join(object_name);
        let mut command = Command::new(emscripten.join(if cxx { "em++" } else { "emcc" }));
        command.args(["-c", source, "-o"]).arg(&object).args([
            "-Oz",
            "-DDUCKDB_NO_THREADS",
            "-DEMSCRIPTEN",
            "-fwasm-exceptions",
            "-sWASM_LEGACY_EXCEPTIONS=0",
            "-Ivendor/duckdb/src/include",
            "-Ibuild/duckdb/_deps/httpfs_extension_fc-src/src/include",
        ]);
        if cxx {
            command.arg("-std=c++17");
        }
        assert!(
            command.status().expect("compile bridge").success(),
            "failed to compile {source}"
        );
        println!("cargo:rustc-link-arg={}", object.display());
    }
    for relative in [
        "extension/core_functions/libcore_functions_extension.a",
        "extension/parquet/libparquet_extension.a",
        "extension/json/libjson_extension.a",
        "extension/httpfs/libhttpfs_extension.a",
        "src/libduckdb_static.a",
    ] {
        let archive = root.join("build/duckdb").join(relative);
        assert!(archive.exists(), "missing required archive: {relative}");
        println!("cargo:rerun-if-changed={}", archive.display());
        println!("cargo:rustc-link-arg={}", archive.display());
    }
    println!("cargo:rustc-link-arg=-sDEFAULT_TO_CXX");
    println!("cargo:rustc-link-arg=-sJSPI_EXPORTS=bridge_run");
    println!("cargo:rustc-link-arg=-Wl,--export=bridge_run");
}
