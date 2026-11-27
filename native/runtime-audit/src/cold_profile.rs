//! Read-only validation for a cold profile copy, including the later profile's withdrawals.
use crate::{
    Result,
    database::{DUCKDB_FORMAT_VERSION, DUCKDB_SCHEMA_VERSION},
};
use duckdb::{AccessMode, Config, Connection};
use std::path::Path;

pub fn verify(file: &Path, known: Option<&Path>) -> Result<()> {
    let db =
        Connection::open_with_flags(file, Config::default().access_mode(AccessMode::ReadOnly)?)?;
    let valid = |schema: &str| -> Result<()> {
        if !db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {schema}.main.database_meta
            WHERE id=1 AND initialized AND format=? AND schema_version=? AND length(database_generation)>0)"),
            duckdb::params![DUCKDB_FORMAT_VERSION,DUCKDB_SCHEMA_VERSION], |row| row.get::<_,bool>(0))? {
            return Err("资料库格式与当前 MyBuddy 不匹配".into());
        }
        Ok(())
    };
    // Use the actual catalog name even when the parent directory was renamed.
    let catalog: String = db.query_row("SELECT current_database()", [], |row| row.get(0))?;
    let quoted = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    let snapshot = quoted(&catalog);
    valid(&snapshot)?;
    let mut tables=db.prepare("SELECT table_name FROM information_schema.tables WHERE table_catalog=? AND table_schema='main' AND table_type='BASE TABLE'")?;
    let names = tables
        .query_map([&catalog], |row| row.get::<_, String>(0))?
        .collect::<duckdb::Result<Vec<_>>>()?;
    for table in names {
        // Materialize all columns so a damaged data block can't pass a metadata-only check.
        db.query_row(
            &format!(
                "SELECT bit_xor(hash(t)) FROM {snapshot}.main.{} t",
                quoted(&table)
            ),
            [],
            |row| row.get::<_, Option<u64>>(0),
        )?;
    }
    if let Some(known) = known {
        let path = known.canonicalize()?;
        let literal = path.to_str().ok_or("对照资料路径无效")?.replace('\'', "''");
        db.execute_batch(&format!("ATTACH '{literal}' AS later (READ_ONLY)"))?;
        valid("later")?;
        for (table, keys, has_cutoff) in [
            (
                "memory_forget_watermarks",
                "s.scope_type=k.scope_type AND s.scope_id=k.scope_id",
                true,
            ),
            (
                "memory_forget_targets",
                "s.scope_type=k.scope_type AND s.scope_id=k.scope_id AND s.fingerprint=k.fingerprint",
                true,
            ),
            (
                "memory_forget_receipts",
                "s.scope_type=k.scope_type AND s.scope_id=k.scope_id AND s.source_message_id=k.source_message_id AND s.request_fingerprint=k.request_fingerprint",
                false,
            ),
        ] {
            let newer = if has_cutoff {
                " OR s.cutoff_at>k.cutoff_at"
            } else {
                ""
            };
            let missing:bool=db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM later.main.{table} k WHERE NOT EXISTS(
                SELECT 1 FROM {snapshot}.main.{table} s WHERE {keys} AND (s IS NOT DISTINCT FROM k{newer})))"),[],|row| row.get(0))?;
            if missing {
                return Err("此快照缺少已知的遗忘记录".into());
            }
        }
        let revoked:bool=db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {snapshot}.main.gateway_dots_bindings s
            WHERE s.active=1 AND NOT EXISTS(SELECT 1 FROM later.main.gateway_dots_bindings k
                WHERE k.active=1 AND k.id=s.id AND k.channel_id=s.channel_id AND k.connection_key=s.connection_key AND k.sender_id=s.sender_id))"),[],|row| row.get(0))?;
        if revoked {
            return Err("此快照仍含对照资料已撤销的私人入口授权".into());
        }
    }
    Ok(())
}
