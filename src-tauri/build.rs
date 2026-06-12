use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Syphon texture sharing is macOS-only; CARGO_CFG_TARGET_OS describes the
    // TARGET platform (build.rs itself compiles for the host).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_syphon();
    }
    tauri_build::build()
}

/// Vendor (if missing) and link Syphon.framework. The bundled app loads it
/// from Contents/Frameworks (see tauri.conf.json bundle.macOS.frameworks);
/// dev and test binaries fall back to the vendor/ copy via a second rpath.
fn link_syphon() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let vendor = manifest.join("vendor");
    let framework_bin = vendor.join("Syphon.framework/Syphon");
    if !framework_bin.exists() {
        let script = manifest.join("scripts/fetch-syphon.sh");
        let fetched = Command::new("/bin/bash")
            .arg(&script)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !fetched || !framework_bin.exists() {
            panic!(
                "\n\nSyphon.framework is missing from src-tauri/vendor and could not be \
                 vendored automatically (network down, or git/clang unavailable?).\n\
                 Run src-tauri/scripts/fetch-syphon.sh manually, then rebuild.\n"
            );
        }
    }
    println!("cargo:rerun-if-changed={}", framework_bin.display());
    println!("cargo:rustc-link-search=framework={}", vendor.display());
    println!("cargo:rustc-link-lib=framework=Syphon");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", vendor.display());
}
