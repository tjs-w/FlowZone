use crate::error::{DynaError, Result};
use std::path::PathBuf;

pub fn data_home() -> Result<PathBuf> {
    #[cfg(not(feature = "isolated-tests"))]
    if std::env::var_os("DYNA_ISOLATED_TEST_HOME").is_some() {
        return Err(DynaError::new(
            "fixture_mode_unavailable",
            "This Dyna build cannot use isolated test storage.",
        ));
    }
    #[cfg(feature = "isolated-tests")]
    if let Some(home) = std::env::var_os("DYNA_ISOLATED_TEST_HOME") {
        return Ok(PathBuf::from(home).join("flowzone-fixture"));
    }
    let home = account_home()?;
    #[cfg(target_os = "macos")]
    let root = home.join("Library/Application Support/Codex/FlowZone");
    #[cfg(not(target_os = "macos"))]
    let root = home.join(".local/share/codex/flowzone");
    Ok(root)
}

#[cfg(unix)]
pub fn account_home() -> Result<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = vec![0u8; 65536];
    let mut user = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found = std::ptr::null_mut();
    let result = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            user.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if result != 0 || found.is_null() {
        return Err(DynaError::storage());
    }
    let user = unsafe { user.assume_init() };
    if user.pw_dir.is_null() {
        return Err(DynaError::storage());
    }
    let bytes = unsafe { CStr::from_ptr(user.pw_dir) }.to_bytes();
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(bytes));
    if !path.is_absolute() {
        return Err(DynaError::storage());
    }
    Ok(path)
}

#[cfg(not(unix))]
pub fn account_home() -> Result<PathBuf> {
    Err(DynaError::new(
        "platform_unavailable",
        "This standalone Dyna build requires a supported local account-home API.",
    ))
}
