use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
};

const GNU_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>"#;

fn embed_gnu_common_controls_manifest() -> io::Result<()> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let manifest = out_dir.join("codex-orchestra.manifest");
    let resource_script = out_dir.join("codex-orchestra-manifest.rc");
    let resource = out_dir.join("codex-orchestra-manifest.res");
    fs::write(&manifest, GNU_APP_MANIFEST)?;
    let manifest_path = manifest.to_string_lossy().replace('\\', "/");
    fs::write(&resource_script, format!("1 24 \"{manifest_path}\"\n"))?;
    let status = Command::new("windres")
        .args(["--input", resource_script.to_string_lossy().as_ref()])
        .args(["--output", resource.to_string_lossy().as_ref()])
        .args(["--output-format", "coff"])
        .status()?;
    if !status.success() {
        return Err(io::Error::other("windres could not embed the app manifest"));
    }
    println!("cargo:rustc-link-arg={}", resource.display());
    Ok(())
}

fn copy_gnu_webview2_loader() -> io::Result<()> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let profile_dir = out_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("Cargo OUT_DIR has a profile directory");
    let target_arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("x86") => "x86",
        Ok("aarch64") => "arm64",
        _ => return Ok(()),
    };
    let build_dir = profile_dir.join("build");
    let loader = fs::read_dir(&build_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .filter(|name| name.starts_with("webview2-com-sys-"))
                .map(|_| {
                    path.join("out")
                        .join(target_arch)
                        .join("WebView2Loader.dll")
                })
        })
        .find(|path| path.is_file());

    if let Some(loader) = loader {
        fs::copy(&loader, profile_dir.join("WebView2Loader.dll"))?;
        // Rust's unit-test executable lives in `profile/deps`, while the
        // distributable application lives at the profile root. Keep the
        // loader beside both so `cargo test` works from a clean GNU target.
        let deps_dir = profile_dir.join("deps");
        fs::create_dir_all(&deps_dir)?;
        fs::copy(loader, deps_dir.join("WebView2Loader.dll"))?;
    } else {
        panic!("WebView2Loader.dll was not produced by webview2-com-sys");
    }
    Ok(())
}

fn main() {
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("gnu") {
        tauri_build::build();
    } else {
        // The regular Tauri resource builder is blocked by a stale GNU
        // plugin-permissions cache. Embed only the manifest required by the
        // runtime, from Cargo's ASCII output directory, instead of dropping
        // all Windows resources.
        embed_gnu_common_controls_manifest()
            .expect("embed Common Controls v6 manifest for GNU target");
        copy_gnu_webview2_loader().expect("copy WebView2Loader.dll for GNU Tauri builds");
    }
}
