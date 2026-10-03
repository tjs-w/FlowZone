pub mod application;
pub mod cli;
pub mod contracts;
pub mod error;
pub mod evidence;
pub mod migration;
pub mod platform;
pub mod publication;
pub mod repository;

pub use application::DynaApplication;
pub use error::{DynaError, Result};
pub use repository::SqliteDynaRepository;
#[cfg(all(feature = "isolated-tests", not(debug_assertions)))]
compile_error!("Dyna release builds must not enable isolated-tests.");
