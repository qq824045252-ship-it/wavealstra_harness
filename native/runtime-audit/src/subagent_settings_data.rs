use crate::plugin_config::{self, Reply, Target};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Read {
        root: PathBuf,
    },
    Replace {
        root: PathBuf,
        version: String,
        text: String,
    },
}

pub fn run(request: Request) -> Reply {
    match request {
        Request::Read { root } => plugin_config::read(Target::subagent_settings(root)),
        Request::Replace {
            root,
            version,
            text,
        } => plugin_config::replace(Target::subagent_settings(root), &version, &text),
    }
}
