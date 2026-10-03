use crate::contracts::*;
use crate::error::{DynaError, Result};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

impl From<rusqlite::Error> for DynaError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(code, _)
                if matches!(
                    code.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                Self::new("busy", "Dyna storage is busy; retry the same request.")
            }
            _ => Self::storage(),
        }
    }
}

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRecord {
    pub id: String,
    pub key: String,
    pub name: String,
    pub database: String,
    pub archived: bool,
    pub available: bool,
}

/// All database access and physical transaction boundaries are behind this
/// interface. Application callbacks contain the rules; persistence never derives
/// lifecycle, effective priority, capabilities, or completion.
pub trait DynaRepository {
    fn list(&self) -> Result<Vec<DashboardRecord>>;
    fn create(&self, dashboard: Dashboard, request: &str, request_hash: &str) -> Result<Value>;
    fn rename(
        &self,
        selector: &str,
        key: &str,
        name: Option<&str>,
        request: &str,
        request_hash: &str,
        now: &str,
    ) -> Result<Value>;
    fn read<T>(&self, selector: &str, f: impl FnOnce(&DashboardState) -> Result<T>) -> Result<T>;
    fn write<T>(
        &self,
        selector: &str,
        f: impl FnOnce(&mut DashboardState) -> Result<T>,
    ) -> Result<T>;
    fn reserve_number(&self, selector: &str, request: &str, item_id: &str) -> Result<i64>;
    fn reserve_task(&self, selector: &str, item_id: &str, task_id: &str) -> Result<()>;
    fn reserve_attempt(&self, selector: &str, item_id: &str, actor: &Actor) -> Result<()>;
    fn replay(
        &self,
        selector: &str,
        request: &str,
        operation: &str,
        hash: &str,
    ) -> Result<Option<Value>>;
    fn mutate(
        &self,
        selector: &str,
        request: &str,
        operation: &str,
        hash: &str,
        f: impl FnOnce(&mut DashboardState) -> Result<Value>,
    ) -> Result<Value>;
    fn recover(&self) -> Result<Value>;
    fn integrity(&self) -> Result<Value>;
    fn backup(&self, request_id: &str) -> Result<Value>;
    fn legacy_inventory(&self) -> Result<LegacyInventory>;
}

pub struct SqliteDynaRepository {
    root: PathBuf,
}

/// The catalog lock is always acquired before a UUID-scoped dashboard lock.
/// Locks are outside renamed database paths and are held for each entire CLI
/// operation, including checkpoint/close/rename. Nothing relies on WAL commits
/// across separate files being atomic.
struct Locks {
    _catalog: File,
    _dashboard: Option<File>,
}

impl Drop for Locks {
    fn drop(&mut self) {
        // A concurrently spawned child can briefly inherit descriptors before
        // exec closes them. Explicitly unlock rather than relying on last-close.
        if let Some(dashboard) = &self._dashboard {
            let _ = FileExt::unlock(dashboard);
        }
        let _ = FileExt::unlock(&self._catalog);
    }
}

impl SqliteDynaRepository {
    pub fn open_migration_preview(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let metadata = fs::symlink_metadata(&root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DynaError::storage());
        }
        let repository = Self {
            root: fs::canonicalize(root)?,
        };
        repository.safe_file(&repository.root.join("dyna.sqlite3"))?;
        if repository.root.join("catalog.sqlite3").exists() {
            return Err(DynaError::new(
                "already_migrated",
                "A Dyna catalog already exists; no legacy migration was planned.",
            ));
        }
        Ok(repository)
    }

    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let mut repository = Self { root: root.into() };
        repository.ensure_directory(&repository.root)?;
        // Resolve macOS's standard /var ancestor before SQLite NOFOLLOW; the
        // requested data-home itself and individual DB files cannot be symlinks.
        repository.root = fs::canonicalize(&repository.root)?;
        for dir in ["dashboards", "locks", "backups"] {
            repository.ensure_directory(&repository.root.join(dir))?;
        }
        let _lock = repository.lock(None)?;
        let catalog_path = repository.root.join("catalog.sqlite3");
        if !catalog_path.exists() && repository.root.join("dyna.sqlite3").exists() {
            return Err(DynaError::new(
                "migration_required",
                "The legacy Dyna store must be migrated explicitly before cutover.",
            ));
        }
        if !catalog_path.exists() && repository.has_prior_use()? {
            return Err(DynaError::new(
                "catalog_missing",
                "The Dyna catalog is missing; recover a coordinated backup.",
            ));
        }
        let conn = repository.connection(&catalog_path, true)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > CATALOG_SCHEMA_VERSION {
            return Err(DynaError::new(
                "future_schema",
                "Dyna catalog requires a newer CLI.",
            ));
        }
        if version == 0 {
            // An empty/truncated catalog is not a new installation. The marker
            // also protects allocations after every dashboard has been removed.
            if repository.has_prior_use()? {
                return Err(DynaError::new(
                    "catalog_missing",
                    "The Dyna catalog requires coordinated recovery; numbering was not reset.",
                ));
            }
            conn.execute_batch(CATALOG_SCHEMA)?;
        }
        repository.mark_initialized()?;
        repository.recover_locked(&conn)?;
        Ok(repository)
    }

    fn has_prior_use(&self) -> Result<bool> {
        if self.root.join(".initialized").exists() || self.root.join("dyna.sqlite3").exists() {
            return Ok(true);
        }
        for directory in ["dashboards", "backups"] {
            if fs::read_dir(self.root.join(directory))?.next().is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn mark_initialized(&self) -> Result<()> {
        let marker = self.root.join(".initialized");
        self.safe_file(&marker)?;
        if !marker.exists() {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            options.open(marker)?.sync_all()?;
            File::open(&self.root)?.sync_all()?;
        }
        Ok(())
    }

    fn ensure_directory(&self, path: &Path) -> Result<()> {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(DynaError::storage());
            }
        } else {
            fs::create_dir_all(path)?;
        }
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    fn safe_file(&self, path: &Path) -> Result<()> {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(DynaError::storage());
            }
        }
        Ok(())
    }

    fn lock(&self, dashboard_id: Option<&str>) -> Result<Locks> {
        let open_lock = |path: PathBuf| -> Result<File> {
            self.safe_file(&path)?;
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            let file = options.open(path)?;
            loop {
                match file.try_lock_exclusive() {
                    Ok(()) => break,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        return Err(DynaError::new(
                            "busy",
                            "Dyna storage is busy; retry the same request.",
                        ));
                    }
                    Err(_) => return Err(DynaError::storage()),
                }
            }
            Ok(file)
        };
        let catalog = open_lock(self.root.join("locks/catalog.lock"))?;
        let dashboard = dashboard_id
            .map(|id| {
                let id = uuid(id)?;
                open_lock(self.root.join("locks").join(format!("{id}.lock")))
            })
            .transpose()?;
        Ok(Locks {
            _catalog: catalog,
            _dashboard: dashboard,
        })
    }

    fn connection(&self, path: &Path, create: bool) -> Result<Connection> {
        self.safe_file(path)?;
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let conn = Connection::open_with_flags(path, flags)?;
        conn.busy_timeout(Duration::from_millis(250))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(conn)
    }

    fn catalog(&self) -> Result<Connection> {
        self.connection(&self.root.join("catalog.sqlite3"), false)
    }

    fn resolve(&self, conn: &Connection, selector: &str) -> Result<DashboardRecord> {
        let normalized = if uuid::Uuid::parse_str(selector).is_ok() {
            uuid(selector)?
        } else {
            dashboard_key(selector)?
        };
        let row = conn.query_row(
            "SELECT d.id,d.key,d.name,d.archived,d.state FROM dashboards d LEFT JOIN dashboard_keys k ON k.dashboard_id=d.id WHERE d.id=?1 OR k.key=?1",
            [&normalized], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?, r.get::<_, String>(4)?)),
        ).optional()?.ok_or(DynaError::new("unknown_dashboard", "Dyna dashboard was not found; list dashboards first."))?;
        Ok(self.record(conn, row))
    }

    fn record(
        &self,
        catalog: &Connection,
        (id, key, name, archived, state): (String, String, String, bool, String),
    ) -> DashboardRecord {
        let database = format!("{key}.sqlite3");
        let mut record = DashboardRecord {
            id,
            key,
            name,
            archived,
            available: false,
            database,
        };
        record.available = state == "ready"
            && self
                .dashboard_path(&record.key)
                .and_then(|path| self.connection(&path, false))
                .and_then(|connection| self.load(&connection, &record.id))
                .and_then(|contents| self.finalize_numbers(catalog, &record, &contents, false))
                .is_ok();
        record
    }

    fn dashboard_path(&self, key: &str) -> Result<PathBuf> {
        Ok(self
            .root
            .join("dashboards")
            .join(format!("{}.sqlite3", dashboard_key(key)?)))
    }

    fn load(&self, conn: &Connection, id: &str) -> Result<DashboardState> {
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != DASHBOARD_SCHEMA_VERSION {
            return Err(DynaError::new(
                "schema_mismatch",
                "Dyna dashboard must be migrated before use.",
            ));
        }
        let payload: String = conn.query_row(
            "SELECT payload FROM dashboard_state WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let mut state: DashboardState =
            serde_json::from_str(&payload).map_err(|_| DynaError::storage())?;
        state.items = self.load_json_rows(conn, "SELECT id,payload FROM item_records")?;
        let mut statement =
            conn.prepare("SELECT payload FROM history_events ORDER BY occurred_at,id")?;
        state.events = statement
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| serde_json::from_str(&r?).map_err(|_| DynaError::storage()))
            .collect::<Result<Vec<Event>>>()?;
        Ok(state)
    }

    fn load_json_rows<T: serde::de::DeserializeOwned>(
        &self,
        conn: &Connection,
        sql: &str,
    ) -> Result<BTreeMap<String, T>> {
        let mut statement = conn.prepare(sql)?;
        let rows =
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|r| {
            let (id, payload) = r?;
            Ok((
                id,
                serde_json::from_str(&payload).map_err(|_| DynaError::storage())?,
            ))
        })
        .collect()
    }

    fn save(&self, conn: &Connection, state: &DashboardState) -> Result<()> {
        let mut metadata = state.clone();
        metadata.items.clear();
        metadata.events.clear();
        conn.execute("INSERT INTO dashboard_state(id,payload) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            params![state.dashboard.id, serde_json::to_string(&metadata)?])?;
        for item in state.items.values() {
            conn.execute("INSERT INTO item_records(id,item_number,payload) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                params![item.id, item.item_number, serde_json::to_string(item)?])?;
        }
        for event in &state.events {
            conn.execute("INSERT OR IGNORE INTO history_events(id,item_id,kind,occurred_at,payload) VALUES(?1,?2,?3,?4,?5)",
                params![event.id, event.item_id, event.kind, event.occurred_at, serde_json::to_string(event)?])?;
        }
        Ok(())
    }

    fn finalize_numbers(
        &self,
        catalog: &Connection,
        record: &DashboardRecord,
        state: &DashboardState,
        finalize: bool,
    ) -> Result<()> {
        // Failed reservations may leave gaps, but committed allocations must
        // still have their durable item (including merged/archived originals).
        // Checking only existing rows would silently accept a missing item.
        let mut statement = catalog.prepare(
            "SELECT item_id,number FROM item_numbers WHERE dashboard_id=?1 AND state='committed'",
        )?;
        let allocations = statement.query_map([&record.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for allocation in allocations {
            let (id, number) = allocation?;
            if state.items.get(&id).map(|item| item.item_number) != Some(number) {
                return Err(DynaError::new(
                    "integrity_failure",
                    "Dyna item allocation is inconsistent.",
                ));
            }
        }
        drop(statement);
        let mut statement = catalog.prepare(
            "SELECT task_id,item_id FROM task_owners WHERE dashboard_id=?1 AND state='committed'",
        )?;
        let owners = statement.query_map([&record.id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for owner in owners {
            let (task_id, item_id) = owner?;
            let item = state.items.get(&item_id);
            let canonical = item
                .and_then(|item| item.legacy.get("mergedInto"))
                .and_then(Value::as_str)
                .and_then(|id| state.items.get(id))
                .or(item);
            if !canonical
                .is_some_and(|item| item.linked_tasks.iter().any(|task| task.task_id == task_id))
            {
                return Err(DynaError::new(
                    "integrity_failure",
                    "Dyna task ownership is inconsistent.",
                ));
            }
        }
        drop(statement);
        for item in state.items.values() {
            let allocation: Option<i64> = catalog
                .query_row(
                    "SELECT number FROM item_numbers WHERE dashboard_id=?1 AND item_id=?2",
                    params![record.id, item.id],
                    |r| r.get(0),
                )
                .optional()?;
            if allocation != Some(item.item_number) {
                return Err(DynaError::new(
                    "integrity_failure",
                    "Dyna item allocation is inconsistent.",
                ));
            }
            if finalize {
                catalog.execute(
                    "UPDATE item_numbers SET state='committed' WHERE item_id=?1",
                    [&item.id],
                )?;
            }
            for task in &item.linked_tasks {
                let owner: Option<(String, String)> = catalog
                    .query_row(
                        "SELECT dashboard_id,item_id FROM task_owners WHERE task_id=?1",
                        [&task.task_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let redirected = owner.as_ref().is_some_and(|(dashboard, alias)| {
                    dashboard == &record.id
                        && state
                            .items
                            .get(alias)
                            .and_then(|i| i.legacy.get("mergedInto"))
                            .and_then(Value::as_str)
                            == Some(item.id.as_str())
                });
                if owner != Some((record.id.clone(), item.id.clone())) && !redirected {
                    return Err(DynaError::new(
                        "integrity_failure",
                        "Dyna task ownership is inconsistent.",
                    ));
                }
                if finalize {
                    catalog.execute(
                        "UPDATE task_owners SET state='committed',item_id=?2 WHERE task_id=?1",
                        params![task.task_id, item.id],
                    )?;
                }
            }
        }
        if finalize {
            catalog.execute(
                "UPDATE dashboards SET name=?2,archived=?3 WHERE id=?1",
                params![record.id, state.dashboard.name, state.dashboard.archived],
            )?;
        }
        Ok(())
    }

    fn initialize_dashboard(&self, catalog: &Connection, id: &str, key: &str) -> Result<()> {
        let initialization: String = catalog.query_row(
            "SELECT initialization FROM dashboards WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let dashboard: Dashboard =
            serde_json::from_str(&initialization).map_err(|_| DynaError::storage())?;
        let mut conn = self.connection(&self.dashboard_path(key)?, true)?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 0 {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(DASHBOARD_SCHEMA)?;
            tx.pragma_update(None, "user_version", DASHBOARD_SCHEMA_VERSION)?;
            self.save(
                &tx,
                &DashboardState {
                    dashboard,
                    items: BTreeMap::new(),
                    events: vec![],
                    publishers: BTreeMap::new(),
                    schedules: vec![],
                    work_identities: BTreeMap::new(),
                    source_separations: vec![],
                },
            )?;
            tx.commit()?;
        } else {
            self.load(&conn, id)?;
        }
        let finalization =
            rusqlite::Transaction::new_unchecked(catalog, TransactionBehavior::Immediate)?;
        finalization.execute("UPDATE dashboards SET state='ready' WHERE id=?1", [id])?;
        let result = envelope(
            "dyna/dashboard-create-result-v1",
            json!({"dashboard":self.resolve(&finalization,id)?,"deduplicated":false}),
        );
        finalization.execute("UPDATE catalog_receipts SET result=?2 WHERE dashboard_id=?1 AND operation='dashboard create' AND result IS NULL",params![id,serde_json::to_string(&result)?])?;
        finalization.commit()?;
        Ok(())
    }

    fn recover_locked(&self, catalog: &Connection) -> Result<Value> {
        let mut statement = catalog
            .prepare("SELECT id,key,name,archived,state FROM dashboards WHERE state<>'ready'")?;
        let pending = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        let mut recovered = 0;
        for row in pending {
            let record = self.record(catalog, row.clone());
            if row.4 == "creating"
                && self
                    .initialize_dashboard(catalog, &record.id, &record.key)
                    .is_ok()
            {
                recovered += 1;
            }
        }
        let mut statement = catalog.prepare("SELECT id,dashboard_id,old_key,new_key,payload FROM recovery_intents WHERE kind='rename' AND state='pending'")?;
        let renames = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        for (intent, id, old, new, payload) in renames {
            // A recoverable failure is local to this intent. Keep it pending
            // and unavailable without hiding unrelated ready dashboards.
            let recovered_intent = (|| -> Result<()> {
                let metadata: Value =
                    serde_json::from_str(&payload).map_err(|_| DynaError::storage())?;
                let old_path = self.dashboard_path(&old)?;
                let new_path = self.dashboard_path(&new)?;
                if old != new && old_path.exists() && new_path.exists() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        let old = fs::symlink_metadata(&old_path)?;
                        let new = fs::symlink_metadata(&new_path)?;
                        if !old.file_type().is_symlink()
                            && !new.file_type().is_symlink()
                            && old.dev() == new.dev()
                            && old.ino() == new.ino()
                        {
                            fs::remove_file(&old_path)?;
                            File::open(self.root.join("dashboards"))?.sync_all()?;
                        } else {
                            return Err(DynaError::new(
                                "recovery_required",
                                "Conflicting Dyna rename files require recovery; nothing was overwritten.",
                            ));
                        }
                    }
                    #[cfg(not(unix))]
                    return Err(DynaError::new(
                        "recovery_required",
                        "Conflicting Dyna rename files require recovery; nothing was overwritten.",
                    ));
                }
                if old != new && old_path.exists() {
                    let conn = self.connection(&old_path, false)?;
                    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
                    conn.close().map_err(|_| DynaError::storage())?;
                    self.move_database(&old_path, &new_path)?;
                }
                if new_path.exists() {
                    let mut conn = self.connection(&new_path, false)?;
                    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    let mut state = self.load(&tx, &id)?;
                    let prior_revision =
                        metadata["revision"].as_u64().ok_or(DynaError::storage())?;
                    if state.dashboard.revision == prior_revision {
                        state.dashboard.revision += 1;
                        state.dashboard.updated_at = metadata["updatedAt"]
                            .as_str()
                            .ok_or(DynaError::storage())?
                            .to_string();
                        if let Some(name) = metadata["name"].as_str() {
                            state.dashboard.name = name.to_string();
                        }
                    } else if state.dashboard.revision != prior_revision + 1 {
                        return Err(DynaError::new(
                            "recovery_required",
                            "Dyna rename revision is inconsistent; no data was overwritten.",
                        ));
                    }
                    state.dashboard.key = new.clone();
                    self.save(&tx, &state)?;
                    tx.commit()?;
                    let finalization = rusqlite::Transaction::new_unchecked(
                        catalog,
                        TransactionBehavior::Immediate,
                    )?;
                    finalization.execute(
                        "UPDATE dashboards SET key=?2,name=?3,state='ready' WHERE id=?1",
                        params![id, new, state.dashboard.name],
                    )?;
                    finalization.execute(
                        "UPDATE recovery_intents SET state='completed' WHERE id=?1",
                        [&intent],
                    )?;
                    let result = envelope(
                        "dyna/dashboard-rename-result-v1",
                        json!({"dashboard":self.resolve(&finalization,&id)?,"deduplicated":false}),
                    );
                    finalization.execute(
                    "UPDATE catalog_receipts SET result=?2 WHERE request_id=?1 AND result IS NULL",
                    params![intent, serde_json::to_string(&result)?],
                )?;
                    finalization.commit()?;
                } else {
                    return Err(DynaError::new(
                        "recovery_required",
                        "A Dyna rename is incomplete; restore its coordinated backup.",
                    ));
                }
                Ok(())
            })();
            if recovered_intent.is_ok() {
                recovered += 1;
            }
        }
        // Reservations keep their numbers on failure. They are never deleted or
        // reallocated. A retry with the same request can finish the original work.
        let records = self.list_locked(catalog)?;
        let unavailable = records.iter().filter(|r| !r.available).count();
        for record in records.into_iter().filter(|r| r.available) {
            let conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
            let state = self.load(&conn, &record.id)?;
            self.finalize_numbers(catalog, &record, &state, true)?;
        }
        Ok(envelope(
            "dyna/recovery-result-v1",
            json!({"recovered": recovered,"unavailableDashboards":unavailable}),
        ))
    }

    fn list_locked(&self, conn: &Connection) -> Result<Vec<DashboardRecord>> {
        let mut statement = conn
            .prepare("SELECT id,key,name,archived,state FROM dashboards ORDER BY created_at,id")?;
        Ok(statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|r| self.record(conn, r))
            .collect())
    }

    fn move_database(&self, old: &Path, new: &Path) -> Result<()> {
        // An exclusive catalog lock excludes every cooperating CLI writer.
        // hard_link is a portable no-replace publication; no rename overwrites.
        self.safe_file(old)?;
        if new.exists() {
            return Err(DynaError::new(
                "reserved_key",
                "The destination dashboard database already exists.",
            ));
        }
        fs::hard_link(old, new)?;
        fs::remove_file(old)?;
        File::open(self.root.join("dashboards"))?.sync_all()?;
        Ok(())
    }
}

impl DynaRepository for SqliteDynaRepository {
    fn list(&self) -> Result<Vec<DashboardRecord>> {
        let _locks = self.lock(None)?;
        Ok(self
            .list_locked(&self.catalog()?)?
            .into_iter()
            .take(100)
            .collect())
    }

    fn create(&self, dashboard: Dashboard, request: &str, request_hash: &str) -> Result<Value> {
        let _locks = self.lock(Some(&dashboard.id))?;
        let mut catalog = self.catalog()?;
        if let Some(result) =
            read_catalog_receipt(&catalog, request, "dashboard create", request_hash)?
        {
            return Ok(result);
        }
        let key = dashboard_key(&dashboard.key)?;
        let exists: bool = catalog.query_row(
            "SELECT EXISTS(SELECT 1 FROM dashboard_keys WHERE key=?1)",
            [&key],
            |r| r.get(0),
        )?;
        if exists || self.dashboard_path(&key)?.exists() {
            return Err(DynaError::new(
                "reserved_key",
                "The dashboard key is already reserved.",
            ));
        }
        let tx = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO dashboards(id,key,name,archived,state,created_at,initialization) VALUES(?1,?2,?3,0,'creating',?4,?5)", params![dashboard.id, key, dashboard.name, dashboard.created_at,serde_json::to_string(&dashboard)?])?;
        tx.execute(
            "INSERT INTO dashboard_keys(key,dashboard_id) VALUES(?1,?2)",
            params![key, dashboard.id],
        )?;
        tx.execute("INSERT INTO catalog_receipts(request_id,dashboard_id,operation,request_hash,result) VALUES(?1,?2,'dashboard create',?3,NULL)",params![request,dashboard.id,request_hash])?;
        tx.commit()?;
        self.initialize_dashboard(&catalog, &dashboard.id, &key)?;
        let mut result = read_catalog_receipt(&catalog, request, "dashboard create", request_hash)?
            .ok_or(DynaError::storage())?;
        result["deduplicated"] = json!(false);
        Ok(result)
    }

    fn rename(
        &self,
        selector: &str,
        key: &str,
        name: Option<&str>,
        request: &str,
        request_hash: &str,
        now: &str,
    ) -> Result<Value> {
        let _catalog_lock = self.lock(None)?;
        let mut catalog = self.catalog()?;
        if let Some(result) =
            read_catalog_receipt(&catalog, request, "dashboard rename", request_hash)?
        {
            return Ok(result);
        }
        let record = self.resolve(&catalog, selector)?;
        if !record.available {
            return Err(DynaError::storage());
        }
        let key = dashboard_key(key)?;
        let reserved: bool = catalog.query_row(
            "SELECT EXISTS(SELECT 1 FROM dashboard_keys WHERE key=?1)",
            [&key],
            |r| r.get(0),
        )?;
        if key != record.key && (reserved || self.dashboard_path(&key)?.exists()) {
            return Err(DynaError::new(
                "reserved_key",
                "The dashboard key is already reserved.",
            ));
        }
        let conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
        let revision = self.load(&conn, &record.id)?.dashboard.revision;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        conn.close().map_err(|_| DynaError::storage())?;
        let intent_id = request.to_string();
        let tx = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if key != record.key {
            tx.execute(
                "INSERT INTO dashboard_keys(key,dashboard_id) VALUES(?1,?2)",
                params![key, record.id],
            )?;
        }
        tx.execute("INSERT INTO recovery_intents(id,kind,dashboard_id,old_key,new_key,state,payload) VALUES(?1,'rename',?2,?3,?4,'pending',?5)", params![intent_id, record.id, record.key, key,serde_json::to_string(&json!({"name":name,"revision":revision,"updatedAt":now}))?])?;
        tx.execute("INSERT INTO catalog_receipts(request_id,dashboard_id,operation,request_hash,result) VALUES(?1,?2,'dashboard rename',?3,NULL)",params![request,record.id,request_hash])?;
        tx.execute(
            "UPDATE dashboards SET state='renaming' WHERE id=?1",
            [&record.id],
        )?;
        tx.commit()?;
        self.recover_locked(&catalog)?;
        let mut result = read_catalog_receipt(&catalog, request, "dashboard rename", request_hash)?
            .ok_or(DynaError::storage())?;
        result["deduplicated"] = json!(false);
        Ok(result)
    }

    fn read<T>(&self, selector: &str, f: impl FnOnce(&DashboardState) -> Result<T>) -> Result<T> {
        let _locks = self.lock(None)?;
        let catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        if !record.available {
            return Err(DynaError::storage());
        }
        let mut conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
        let tx = conn.transaction()?;
        let state = self.load(&tx, &record.id)?;
        let result = f(&state)?;
        tx.commit()?;
        Ok(result)
    }

    fn write<T>(
        &self,
        selector: &str,
        f: impl FnOnce(&mut DashboardState) -> Result<T>,
    ) -> Result<T> {
        let _locks = self.lock(None)?;
        let catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        if !record.available {
            return Err(DynaError::storage());
        }
        let mut conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = self.load(&tx, &record.id)?;
        let result = f(&mut state)?;
        self.finalize_numbers(&catalog, &record, &state, false)?;
        self.save(&tx, &state)?;
        tx.commit()?;
        self.finalize_numbers(&catalog, &record, &state, true)?;
        Ok(result)
    }

    fn reserve_number(&self, selector: &str, request: &str, item_id: &str) -> Result<i64> {
        let _locks = self.lock(None)?;
        let mut catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        let tx = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT number,item_id FROM item_numbers WHERE dashboard_id=?1 AND request_id=?2",
                params![record.id, request],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((number, existing_id)) = existing {
            if item_id != existing_id {
                return Err(DynaError::new(
                    "request_conflict",
                    "Dyna request ID was reused with different content.",
                ));
            }
            return Ok(number);
        }
        tx.execute("INSERT INTO item_numbers(item_id,dashboard_id,request_id,state) VALUES(?1,?2,?3,'reserved')", params![item_id, record.id, request])?;
        let number = tx.last_insert_rowid();
        if number > MAX_ITEM_NUMBER {
            return Err(DynaError::new(
                "number_exhausted",
                "Dyna item number allocation is exhausted.",
            ));
        }
        tx.commit()?;
        Ok(number)
    }

    fn reserve_task(&self, selector: &str, item_id: &str, task_id: &str) -> Result<()> {
        let _locks = self.lock(None)?;
        let mut catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        let tx = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner: Option<(String, String)> = tx
            .query_row(
                "SELECT dashboard_id,item_id FROM task_owners WHERE task_id=?1",
                [task_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some(owner) = owner {
            if owner != (record.id, item_id.to_string()) {
                return Err(DynaError::new(
                    "task_owned",
                    "The Codex task is already reserved for another Dyna item.",
                ));
            }
        } else {
            tx.execute("INSERT INTO task_owners(task_id,dashboard_id,item_id,state) VALUES(?1,?2,?3,'reserved')", params![task_id, record.id, item_id])?;
        }
        tx.commit()?;
        Ok(())
    }

    fn reserve_attempt(&self, selector: &str, item_id: &str, actor: &Actor) -> Result<()> {
        let _locks = self.lock(None)?;
        let mut catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        let attempt = actor
            .work_attempt_id
            .as_deref()
            .ok_or(DynaError::invalid())?;
        let task = actor.task_id.as_deref().ok_or(DynaError::invalid())?;
        let tx = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner: Option<(String, String, String)> = tx
            .query_row(
                "SELECT dashboard_id,item_id,task_id FROM work_attempts WHERE id=?1",
                [attempt],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some(owner) = owner {
            if owner.0 != record.id || owner.2 != task {
                return Err(DynaError::new(
                    "forbidden",
                    "A Dyna work attempt cannot switch item or task identity.",
                ));
            }
            if owner.1 != item_id {
                let dashboard = self.connection(&self.dashboard_path(&record.key)?, false)?;
                let state = self.load(&dashboard, &record.id)?;
                // A verified merge changes routing, not the work attempt's task identity.
                let canonical = state
                    .items
                    .get(&owner.1)
                    .and_then(|item| item.legacy.get("mergedInto"))
                    .and_then(Value::as_str);
                if canonical != Some(item_id) {
                    return Err(DynaError::new(
                        "forbidden",
                        "A Dyna work attempt cannot switch item or task identity.",
                    ));
                }
                tx.execute(
                    "UPDATE work_attempts SET item_id=?2 WHERE id=?1",
                    params![attempt, item_id],
                )?;
            }
        } else {
            tx.execute(
                "INSERT INTO work_attempts(id,dashboard_id,item_id,task_id) VALUES(?1,?2,?3,?4)",
                params![attempt, record.id, item_id, task],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn replay(
        &self,
        selector: &str,
        request: &str,
        operation: &str,
        hash: &str,
    ) -> Result<Option<Value>> {
        let _locks = self.lock(None)?;
        let catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        let conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
        read_receipt(&conn, request, operation, hash)
    }

    fn mutate(
        &self,
        selector: &str,
        request: &str,
        operation: &str,
        hash: &str,
        f: impl FnOnce(&mut DashboardState) -> Result<Value>,
    ) -> Result<Value> {
        let _locks = self.lock(None)?;
        let catalog = self.catalog()?;
        let record = self.resolve(&catalog, selector)?;
        if !record.available {
            return Err(DynaError::storage());
        }
        let mut conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(result) = read_receipt(&tx, request, operation, hash)? {
            return Ok(result);
        }
        let mut state = self.load(&tx, &record.id)?;
        let result = f(&mut state)?;
        self.finalize_numbers(&catalog, &record, &state, false)?;
        self.save(&tx, &state)?;
        tx.execute("INSERT INTO request_receipts(request_id,operation,request_hash,result) VALUES(?1,?2,?3,?4)", params![request, operation, hash, serde_json::to_string(&result)?])?;
        tx.commit()?;
        self.finalize_numbers(&catalog, &record, &state, true)?;
        Ok(result)
    }

    fn recover(&self) -> Result<Value> {
        let _locks = self.lock(None)?;
        self.recover_locked(&self.catalog()?)
    }

    fn integrity(&self) -> Result<Value> {
        let _locks = self.lock(None)?;
        let catalog = self.catalog()?;
        assert_integrity(&catalog)?;
        let records = self.list_locked(&catalog)?;
        for record in &records {
            if !record.available {
                return Err(DynaError::new(
                    "integrity_failure",
                    "A Dyna dashboard database is unavailable.",
                ));
            }
            let conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
            assert_integrity(&conn)?;
            let state = self.load(&conn, &record.id)?;
            self.finalize_numbers(&catalog, record, &state, false)?;
        }
        Ok(envelope(
            "dyna/integrity-result-v1",
            json!({"valid": true, "dashboards": records.len()}),
        ))
    }

    fn backup(&self, request_id: &str) -> Result<Value> {
        let request_id = uuid(request_id)?;
        let _locks = self.lock(None)?;
        let catalog = self.catalog()?;
        let destination = self.root.join("backups").join(&request_id);
        let manifest = destination.join("manifest.json");
        if destination.exists() {
            self.ensure_directory(&destination)?;
            self.safe_file(&manifest)?;
            if !manifest.is_file() {
                return Err(DynaError::new(
                    "backup_incomplete",
                    "The prior backup is incomplete; no complete backup was reported.",
                ));
            }
            let bytes = fs::read(&manifest)?;
            if bytes.len() > MAX_STDOUT {
                return Err(DynaError::storage());
            }
            let mut result: Value =
                serde_json::from_slice(&bytes).map_err(|_| DynaError::storage())?;
            if result["schema"] != "dyna/backup-result-v1"
                || result["backupId"] != request_id
                || result["complete"] != true
            {
                return Err(DynaError::storage());
            }
            let records = self.list_backup_records(&destination)?;
            if result["dashboards"].as_u64() != Some(records.len() as u64) {
                return Err(DynaError::storage());
            }
            result["deduplicated"] = json!(true);
            return Ok(result);
        }
        // Under the catalog lock no dashboard can commit or be renamed while
        // SQLite's backup API copies the catalog and every dashboard file.
        let records = self.list_locked(&catalog)?;
        if records.iter().any(|record| !record.available) {
            return Err(DynaError::storage());
        }
        self.ensure_directory(&destination)?;
        for record in &records {
            if !record.available {
                return Err(DynaError::storage());
            }
            let conn = self.connection(&self.dashboard_path(&record.key)?, false)?;
            conn.backup("main", destination.join(&record.database), None)?;
            #[cfg(unix)]
            fs::set_permissions(
                destination.join(&record.database),
                fs::Permissions::from_mode(0o600),
            )?;
            File::open(destination.join(&record.database))?.sync_all()?;
        }
        catalog.backup("main", destination.join("catalog.sqlite3"), None)?;
        #[cfg(unix)]
        fs::set_permissions(
            destination.join("catalog.sqlite3"),
            fs::Permissions::from_mode(0o600),
        )?;
        File::open(destination.join("catalog.sqlite3"))?.sync_all()?;
        self.list_backup_records(&destination)?;
        let result = envelope(
            "dyna/backup-result-v1",
            json!({"backupId":request_id,"dashboards":records.len(),"complete":true,"deduplicated":false}),
        );
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        use std::io::Write;
        let mut output = options.open(manifest)?;
        output.write_all(&serde_json::to_vec(&result)?)?;
        output.sync_all()?;
        File::open(&destination)?.sync_all()?;
        Ok(result)
    }

    fn legacy_inventory(&self) -> Result<LegacyInventory> {
        let path = self.root.join("dyna.sqlite3");
        self.safe_file(&path)?;
        let mut database = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        database.busy_timeout(Duration::from_millis(250))?;
        let tx = database.transaction()?;
        let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != 14 {
            return Err(DynaError::new(
                "migration_unavailable",
                "Only Dyna schema v14 can be planned.",
            ));
        }
        if tx.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))? != "ok" {
            return Err(DynaError::storage());
        }
        let high_water:i64 = tx.query_row("SELECT MAX(COALESCE((SELECT MAX(number) FROM item_numbers),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='item_numbers'),0))",[],|r|r.get(0))?;
        let dashboards = tx
            .prepare("SELECT id,name,created_at,archived FROM dashboards ORDER BY created_at,id LIMIT 101")?
            .query_map([], |r| {
                Ok(LegacyDashboard {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get(2)?,
                    archived: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let memberships = tx.prepare("SELECT d.dashboard_id,d.item_id,n.number FROM dashboard_items d JOIN items i ON i.id=d.item_id JOIN item_numbers n ON n.item_id=i.id ORDER BY n.number,d.dashboard_id LIMIT 20001")?.query_map([],|r|Ok(LegacyMembership {dashboard_id:r.get(0)?,item_id:r.get(1)?,item_number:r.get(2)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let missing:i64 = tx.query_row("SELECT COUNT(*) FROM dashboard_items d LEFT JOIN items i ON i.id=d.item_id LEFT JOIN item_numbers n ON n.item_id=d.item_id WHERE i.id IS NULL OR n.number IS NULL",[],|r|r.get(0))?;
        if missing != 0 {
            return Err(DynaError::storage());
        }
        let tasks = tx
            .prepare(
                "SELECT item_id,task_id FROM task_bindings ORDER BY task_id,item_id LIMIT 20001",
            )?
            .query_map([], |r| {
                Ok(LegacyTaskOwner {
                    item_id: r.get(0)?,
                    task_id: r.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        tx.commit()?;
        Ok(LegacyInventory {
            schema_version: version,
            number_high_water: high_water,
            dashboards,
            memberships,
            tasks,
        })
    }
}

impl SqliteDynaRepository {
    fn list_backup_records(&self, destination: &Path) -> Result<Vec<DashboardRecord>> {
        self.safe_file(&destination.join("catalog.sqlite3"))?;
        let catalog = Connection::open_with_flags(
            destination.join("catalog.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        assert_integrity(&catalog)?;
        let mut statement = catalog
            .prepare("SELECT id,key,name,archived,state FROM dashboards ORDER BY created_at,id")?;
        let records = statement
            .query_map([], |r| {
                Ok(DashboardRecord {
                    id: r.get(0)?,
                    key: r.get(1)?,
                    name: r.get(2)?,
                    database: String::new(),
                    archived: r.get(3)?,
                    available: r.get::<_, String>(4)? == "ready",
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for record in &records {
            if !record.available {
                return Err(DynaError::storage());
            }
            let basename = format!("{}.sqlite3", dashboard_key(&record.key)?);
            self.safe_file(&destination.join(&basename))?;
            let database = Connection::open_with_flags(
                destination.join(basename),
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )?;
            assert_integrity(&database)?;
            let state = self.load(&database, &record.id)?;
            self.finalize_numbers(&catalog, record, &state, false)?;
        }
        Ok(records)
    }
}

fn read_receipt(
    conn: &Connection,
    request: &str,
    operation: &str,
    hash: &str,
) -> Result<Option<Value>> {
    let receipt = conn
        .query_row(
            "SELECT operation,request_hash,result FROM request_receipts WHERE request_id=?1",
            [request],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((old_operation, old_hash, result)) = receipt {
        if old_operation != operation || old_hash != hash {
            return Err(DynaError::new(
                "request_conflict",
                "Dyna request ID was reused with different content.",
            ));
        }
        let mut result: Value = serde_json::from_str(&result).map_err(|_| DynaError::storage())?;
        result["deduplicated"] = json!(true);
        Ok(Some(result))
    } else {
        Ok(None)
    }
}

fn read_catalog_receipt(
    conn: &Connection,
    request: &str,
    operation: &str,
    hash: &str,
) -> Result<Option<Value>> {
    let row = conn
        .query_row(
            "SELECT operation,request_hash,result FROM catalog_receipts WHERE request_id=?1",
            [request],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((op, old_hash, result)) => {
            if op != operation || old_hash != hash {
                return Err(DynaError::new(
                    "request_conflict",
                    "Dyna request ID was reused with different content.",
                ));
            }
            let mut result: Value =
                serde_json::from_str(result.as_deref().ok_or(DynaError::new(
                    "recovery_required",
                    "The Dyna operation is pending recovery; retry after recovery.",
                ))?)
                .map_err(|_| DynaError::storage())?;
            result["deduplicated"] = json!(true);
            Ok(Some(result))
        }
    }
}

fn assert_integrity(conn: &Connection) -> Result<()> {
    let integrity: String = conn.pragma_query_value(None, "integrity_check", |r| r.get(0))?;
    let foreign_key_errors = conn
        .prepare("PRAGMA foreign_key_check")?
        .query([])?
        .next()?
        .is_some();
    if integrity != "ok" || foreign_key_errors {
        return Err(DynaError::new(
            "integrity_failure",
            "Dyna storage integrity check failed.",
        ));
    }
    Ok(())
}

const CATALOG_SCHEMA: &str = r#"
BEGIN IMMEDIATE;
CREATE TABLE dashboards(id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,created_at TEXT NOT NULL,initialization TEXT NOT NULL);
CREATE TABLE dashboard_keys(key TEXT PRIMARY KEY,dashboard_id TEXT NOT NULL REFERENCES dashboards(id));
CREATE TABLE item_numbers(number INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL UNIQUE,dashboard_id TEXT NOT NULL REFERENCES dashboards(id),request_id TEXT NOT NULL,state TEXT NOT NULL,CHECK(number>0 AND number<=9007199254740991),UNIQUE(dashboard_id,request_id));
CREATE TRIGGER item_numbers_no_delete BEFORE DELETE ON item_numbers BEGIN SELECT RAISE(ABORT,'allocation is permanent'); END;
CREATE TRIGGER item_numbers_no_reassign BEFORE UPDATE OF number,item_id,dashboard_id,request_id ON item_numbers BEGIN SELECT RAISE(ABORT,'allocation is immutable'); END;
CREATE TABLE task_owners(task_id TEXT PRIMARY KEY,dashboard_id TEXT NOT NULL REFERENCES dashboards(id),item_id TEXT NOT NULL,state TEXT NOT NULL);
CREATE TABLE work_attempts(id TEXT PRIMARY KEY,dashboard_id TEXT NOT NULL REFERENCES dashboards(id),item_id TEXT NOT NULL,task_id TEXT NOT NULL);
CREATE TABLE recovery_intents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,dashboard_id TEXT NOT NULL REFERENCES dashboards(id),old_key TEXT,new_key TEXT,state TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '{}');
CREATE TABLE catalog_receipts(request_id TEXT PRIMARY KEY,dashboard_id TEXT NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT);
PRAGMA user_version=1;
COMMIT;
"#;

const DASHBOARD_SCHEMA: &str = r#"
CREATE TABLE dashboard_state(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE item_records(id TEXT PRIMARY KEY,item_number INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL,CHECK(item_number>0 AND item_number<=9007199254740991));
CREATE TRIGGER item_identity_immutable BEFORE UPDATE OF id,item_number ON item_records BEGIN SELECT RAISE(ABORT,'item identity is immutable'); END;
CREATE TABLE history_events(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX history_item ON history_events(item_id,occurred_at DESC,id DESC);
CREATE TRIGGER history_no_update BEFORE UPDATE ON history_events BEGIN SELECT RAISE(ABORT,'history is append only'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON history_events BEGIN SELECT RAISE(ABORT,'history is append only'); END;
CREATE TABLE request_receipts(request_id TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL);
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON request_receipts BEGIN SELECT RAISE(ABORT,'receipt is append only'); END;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON request_receipts BEGIN SELECT RAISE(ABORT,'receipt is append only'); END;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn dashboard(key: &str) -> Dashboard {
        Dashboard {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.into(),
            name: key.into(),
            description: String::new(),
            archived: false,
            revision: 0,
            done_retention_hours: 24,
            created_at: "2026-10-01T00:00:00.000Z".into(),
            updated_at: "2026-10-01T00:00:00.000Z".into(),
        }
    }
    fn setup() -> (tempfile::TempDir, SqliteDynaRepository, Dashboard) {
        let dir = tempfile::tempdir().unwrap();
        let repo = SqliteDynaRepository::open(dir.path()).unwrap();
        let d = dashboard("linus");
        repo.create(d.clone(), &uuid::Uuid::new_v4().to_string(), "hash")
            .unwrap();
        (dir, repo, d)
    }

    fn create_test_item(repo: &SqliteDynaRepository) -> Value {
        let app = crate::application::DynaApplication::new(
            SqliteDynaRepository::open(&repo.root).unwrap(),
        );
        app.execute(
            &crate::application::Request {
                operation: "todo create".into(),
                dashboard: Some("linus".into()),
                ..Default::default()
            },
            Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"title":"Durable evidence"})),
            "2026-10-01T10:00:00.000Z",
        )
        .unwrap()
    }

    #[test]
    fn committed_allocation_requires_a_live_row_but_reserved_gaps_are_valid() {
        let (_dir, repo, _) = setup();
        repo.reserve_number("linus", "abandoned", "reserved-item")
            .unwrap();
        assert_eq!(repo.integrity().unwrap()["valid"], true);
        assert_eq!(
            repo.backup(&uuid::Uuid::new_v4().to_string()).unwrap()["complete"],
            true
        );
        let item = create_test_item(&repo);
        let db = Connection::open(repo.dashboard_path("linus").unwrap()).unwrap();
        db.execute(
            "DELETE FROM item_records WHERE id=?1",
            [item["itemId"].as_str().unwrap()],
        )
        .unwrap();
        drop(db);
        assert_eq!(repo.integrity().unwrap_err().code, "integrity_failure");
        let backup_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            repo.backup(&backup_id).unwrap_err().code,
            "storage_unavailable"
        );
        assert!(
            !repo
                .root
                .join(format!("backups/{backup_id}/manifest.json"))
                .exists()
        );
    }

    #[test]
    fn backup_replay_rejects_a_missing_committed_item() {
        let (_dir, repo, _) = setup();
        let item = create_test_item(&repo);
        let backup_id = uuid::Uuid::new_v4().to_string();
        repo.backup(&backup_id).unwrap();
        let db =
            Connection::open(repo.root.join(format!("backups/{backup_id}/linus.sqlite3"))).unwrap();
        db.execute(
            "DELETE FROM item_records WHERE id=?1",
            [item["itemId"].as_str().unwrap()],
        )
        .unwrap();
        drop(db);
        assert_eq!(
            repo.backup(&backup_id).unwrap_err().code,
            "integrity_failure"
        );
        assert_eq!(repo.integrity().unwrap()["valid"], true);
    }

    #[test]
    fn missing_committed_item_is_isolated_to_its_dashboard_after_reopen() {
        let (dir, repo, _) = setup();
        let damaged = create_test_item(&repo);
        let healthy = dashboard("healthy");
        repo.create(healthy, &uuid::Uuid::new_v4().to_string(), "hash")
            .unwrap();
        let db = Connection::open(repo.dashboard_path("linus").unwrap()).unwrap();
        db.execute(
            "DELETE FROM item_records WHERE id=?1",
            [damaged["itemId"].as_str().unwrap()],
        )
        .unwrap();
        drop(db);
        drop(repo);
        let repo = SqliteDynaRepository::open(dir.path()).unwrap();
        let listed = repo.list().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(!listed.iter().find(|d| d.key == "linus").unwrap().available);
        assert!(
            listed
                .iter()
                .find(|d| d.key == "healthy")
                .unwrap()
                .available
        );
        assert_eq!(
            repo.read("linus", |_| Ok(())).unwrap_err().code,
            "storage_unavailable"
        );
        repo.write("healthy", |state| {
            state.dashboard.name = "Healthy changes still work".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            repo.read("healthy", |state| Ok(state.dashboard.name.clone()))
                .unwrap(),
            "Healthy changes still work"
        );
        assert_eq!(repo.integrity().unwrap_err().code, "integrity_failure");
        assert_eq!(
            repo.backup(&uuid::Uuid::new_v4().to_string())
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(repo.recover().unwrap()["unavailableDashboards"], 1);
    }

    #[test]
    fn backups_require_foreign_key_integrity_on_creation_and_replay() {
        for replay in [false, true] {
            let (_dir, repo, _) = setup();
            let backup_id = uuid::Uuid::new_v4().to_string();
            let catalog = if replay {
                repo.backup(&backup_id).unwrap();
                Connection::open(
                    repo.root
                        .join(format!("backups/{backup_id}/catalog.sqlite3")),
                )
                .unwrap()
            } else {
                repo.catalog().unwrap()
            };
            catalog.pragma_update(None, "foreign_keys", "OFF").unwrap();
            catalog.execute("INSERT INTO dashboard_keys(key,dashboard_id) VALUES('orphan','missing-dashboard')", []).unwrap();
            drop(catalog);
            assert_eq!(
                repo.backup(&backup_id).unwrap_err().code,
                "integrity_failure"
            );
            if !replay {
                assert!(
                    !repo
                        .root
                        .join(format!("backups/{backup_id}/manifest.json"))
                        .exists()
                );
            }
        }
    }

    #[test]
    fn interrupted_creation_is_resumed_from_metadata() {
        let (dir, repo, d) = setup();
        let catalog = repo.catalog().unwrap();
        catalog
            .execute(
                "UPDATE dashboards SET state='creating' WHERE id=?1",
                [&d.id],
            )
            .unwrap();
        catalog
            .execute(
                "UPDATE catalog_receipts SET result=NULL WHERE dashboard_id=?1",
                [&d.id],
            )
            .unwrap();
        drop(catalog);
        fs::remove_file(repo.dashboard_path("linus").unwrap()).unwrap();
        drop(repo);
        let repo = SqliteDynaRepository::open(dir.path()).unwrap();
        assert!(repo.list().unwrap()[0].available);
        assert_eq!(
            repo.read("linus", |s| Ok(s.dashboard.id.clone())).unwrap(),
            d.id
        );
    }

    #[test]
    #[cfg(unix)]
    fn interrupted_no_replace_rename_with_two_names_for_same_inode_recovers() {
        let (dir, repo, d) = setup();
        let catalog = repo.catalog().unwrap();
        catalog
            .execute(
                "INSERT INTO dashboard_keys(key,dashboard_id) VALUES('work',?1)",
                [&d.id],
            )
            .unwrap();
        let req = uuid::Uuid::new_v4().to_string();
        catalog.execute("INSERT INTO recovery_intents(id,kind,dashboard_id,old_key,new_key,state,payload) VALUES(?1,'rename',?2,'linus','work','pending',?3)",params![req,d.id,serde_json::to_string(&json!({"revision":0,"name":"Work","updatedAt":"2026-10-01T01:00:00.000Z"})).unwrap()]).unwrap();
        catalog.execute("INSERT INTO catalog_receipts(request_id,dashboard_id,operation,request_hash,result) VALUES(?1,?2,'dashboard rename','hash',NULL)",params![req,d.id]).unwrap();
        fs::hard_link(
            repo.dashboard_path("linus").unwrap(),
            repo.dashboard_path("work").unwrap(),
        )
        .unwrap();
        drop(catalog);
        drop(repo);
        let repo = SqliteDynaRepository::open(dir.path()).unwrap();
        let state = repo.read("linus", |s| Ok(s.dashboard.clone())).unwrap();
        assert_eq!(state.key, "work");
        assert_eq!(state.name, "Work");
        assert_eq!(state.revision, 1);
        assert!(!dir.path().join("dashboards/linus.sqlite3").exists());
        assert!(dir.path().join("dashboards/work.sqlite3").exists());
    }

    #[test]
    fn future_schema_is_rejected() {
        let (dir, repo, _) = setup();
        repo.catalog()
            .unwrap()
            .pragma_update(None, "user_version", 99)
            .unwrap();
        drop(repo);
        assert!(matches!(SqliteDynaRepository::open(dir.path()),Err(e)if e.code=="future_schema"));
    }

    #[test]
    fn ledger_tombstones_cannot_be_deleted_or_reassigned() {
        let (_dir, repo, _) = setup();
        let number = repo.reserve_number("linus", "request", "item").unwrap();
        let catalog = repo.catalog().unwrap();
        assert!(
            catalog
                .execute("DELETE FROM item_numbers WHERE number=?1", [number])
                .is_err()
        );
        assert!(
            catalog
                .execute(
                    "UPDATE item_numbers SET item_id='other' WHERE number=?1",
                    [number]
                )
                .is_err()
        );
        assert!(
            repo.reserve_number("linus", "request", "different")
                .is_err()
        );
        assert_eq!(
            repo.reserve_number("linus", "request2", "next").unwrap(),
            number + 1
        );
    }

    #[test]
    fn physical_transaction_rolls_back_callback_failure() {
        let (_dir, repo, _) = setup();
        let result: Result<()> = repo.write("linus", |state| {
            state.dashboard.name = "Not committed".into();
            Err(DynaError::invalid())
        });
        assert!(result.is_err());
        assert_eq!(
            repo.read("linus", |s| Ok(s.dashboard.name.clone()))
                .unwrap(),
            "linus"
        );
    }

    #[test]
    fn maintenance_enumerates_beyond_public_list_limit() {
        let (_dir, repo, _) = setup();
        for i in 0..100 {
            let d = dashboard(&format!("d{i}"));
            repo.create(d, &uuid::Uuid::new_v4().to_string(), "hash")
                .unwrap();
        }
        assert_eq!(repo.list().unwrap().len(), 100);
        assert_eq!(repo.integrity().unwrap()["dashboards"], 101);
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(repo.backup(&id).unwrap()["dashboards"], 101);
        assert!(
            repo.root
                .join(format!("backups/{id}/d99.sqlite3"))
                .is_file()
        );
    }

    #[test]
    fn symlink_database_is_rejected_without_following_target() {
        #[cfg(unix)]
        {
            let (_dir, repo, _) = setup();
            let db = repo.dashboard_path("linus").unwrap();
            let other = repo.root.join("private.sqlite3");
            fs::rename(&db, &other).unwrap();
            std::os::unix::fs::symlink(&other, &db).unwrap();
            assert!(repo.read("linus", |_| Ok(())).is_err());
        }
    }
}
