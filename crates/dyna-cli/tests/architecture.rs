use std::fs;

#[test]
fn sqlite_is_private_to_repository() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == "repository.rs" {
            continue;
        }
        let contents = fs::read_to_string(entry.path()).unwrap();
        assert!(
            !contents.contains("rusqlite"),
            "{} bypasses repository persistence",
            entry.file_name().to_string_lossy()
        );
    }
}

#[test]
fn application_and_projectors_are_transport_independent() {
    for file in [
        "application.rs",
        "publication.rs",
        "evidence.rs",
        "contracts.rs",
        "migration.rs",
    ] {
        let text = fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join(file),
        )
        .unwrap();
        for forbidden in [
            "std::process",
            "TcpStream",
            "TcpListener",
            "UdpSocket",
            "std::env",
            "rusqlite",
            "libc::",
            "SELECT ",
            "UPDATE ",
            "INSERT INTO ",
        ] {
            assert!(
                !text.contains(forbidden),
                "{file} contains transport or SQL dependency {forbidden}"
            );
        }
    }
    let text = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/repository.rs"),
    )
    .unwrap();
    for forbidden in [
        "application::project",
        "effective_priority(",
        "ActorKind::",
        "completion_reported",
        "waiting_for_input",
    ] {
        assert!(
            !text.contains(forbidden),
            "repository derives a business rule: {forbidden}"
        );
    }
}
