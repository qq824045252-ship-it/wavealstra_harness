use crate::{Result, gadget_materialize::write_new, library_text::is_link};
use duckdb::Connection;
use std::{fs, io::Read, path::Path};

// Successful writes keep this marker so later startup can prove ownership before sweeping.
pub(crate) const MARKER: &str = ".mybuddy-storage-generation";

pub(crate) fn generation(db: &Connection) -> Result<String> {
    Ok(db.query_row(
        "SELECT database_generation FROM database_meta WHERE id=1 AND initialized",
        [],
        |row| row.get(0),
    )?)
}

pub(crate) fn mark(directory: &Path, generation: &str) -> Result<()> {
    if generation.is_empty() {
        return Err("Missing managed storage database generation".into());
    }
    write_new(&directory.join(MARKER), generation.as_bytes())
}

pub(crate) fn matches(directory: &Path, generation: &str) -> bool {
    if generation.is_empty() || !fs::symlink_metadata(directory)
        .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata))
    {
        return false;
    }
    let marker = directory.join(MARKER);
    fs::symlink_metadata(&marker).is_ok_and(|metadata| {
        metadata.is_file() && !is_link(&metadata) && metadata.len() == generation.len() as u64
    }) && fs::File::open(marker).is_ok_and(|file| {
        let mut contents = Vec::with_capacity(generation.len());
        file.take(generation.len() as u64 + 1)
            .read_to_end(&mut contents)
            .is_ok_and(|_| contents == generation.as_bytes())
    })
}
