use dyna::cli::{self, Invocation};
use dyna::{DynaApplication, Result, SqliteDynaRepository};
use serde_json::json;
use std::io::{self, Write};

fn run(raw_args: &[std::ffi::OsString]) -> Result<()> {
    #[cfg(unix)]
    let quiet = cli::NonEchoInput::begin()?;
    let args = raw_args
        .iter()
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or_else(dyna::DynaError::invalid)
        })
        .collect::<Result<Vec<_>>>()?;
    let invocation = cli::parse(&args)?;
    match invocation {
        Invocation::Help => {
            println!("{}", cli::HELP);
            Ok(())
        }
        Invocation::Version => {
            println!("dyna {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Invocation::Command(parsed) => {
            let input = if parsed.mutation {
                #[cfg(unix)]
                let terminal = quiet.is_terminal();
                #[cfg(not(unix))]
                let terminal = false;
                Some(cli::read_input_mode(io::stdin().lock(), terminal)?)
            } else {
                None
            };
            let root = dyna::platform::data_home()?;
            let repository = if parsed.request.operation == "maintenance migration-plan" {
                SqliteDynaRepository::open_migration_preview(root)?
            } else {
                SqliteDynaRepository::open(root)?
            };
            let application = DynaApplication::new(repository);
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            if parsed.request.operation == "dashboard pick" {
                #[cfg(unix)]
                drop(quiet);
                #[cfg(unix)]
                if unsafe { libc::isatty(libc::STDIN_FILENO) } == 0 {
                    return Err(dyna::DynaError::new(
                        "invalid_input",
                        "Dashboard picker requires a terminal; use dashboard list --json in scripts.",
                    ));
                }
                let request = dyna::application::Request {
                    operation: "dashboard list".to_string(),
                    ..Default::default()
                };
                let list = application.execute(&request, None, &now)?;
                let choices = list["dashboards"].as_array().unwrap();
                for (index, dashboard) in choices.iter().enumerate() {
                    eprintln!(
                        "{}. {} — {}",
                        index + 1,
                        cli::terminal_label(dashboard["key"].as_str().unwrap_or("")),
                        cli::terminal_label(dashboard["name"].as_str().unwrap_or(""))
                    );
                }
                eprint!("Choose dashboard: ");
                io::stderr().flush().ok();
                let mut response = String::new();
                io::stdin()
                    .read_line(&mut response)
                    .map_err(|_| dyna::DynaError::invalid())?;
                let selected = response
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|n| choices.get(n))
                    .ok_or(dyna::DynaError::invalid())?;
                return cli::print_result(
                    &json!({"schema":"dyna/dashboard-pick-result-v1","dashboard":selected}),
                    parsed.json,
                    io::stdout().lock(),
                );
            }
            let result = application.execute(&parsed.request, input, &now)?;
            cli::print_result(&result, parsed.json, io::stdout().lock())
        }
    }
}

fn main() {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Err(error) = run(&args) {
        if args.iter().any(|a| a == "--json") {
            eprintln!("{}", json!({"schema":"dyna/error-v1","error":error}));
        } else {
            eprintln!("{error}");
        }
        std::process::exit(error.exit_code());
    }
}
