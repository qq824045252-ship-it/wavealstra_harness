use crate::{
    Result,
    connector_install::{self, is_unsupported, real_directory},
    dots_file_revision::same_path,
    plugin_catalog::directories,
    plugin_config,
};
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const RETIRED_DIRECTORY: &str = ".mybuddy-connector-market-retired";
static NEXT_TICKET: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Delete {
        id: String,
        roots: Vec<PathBuf>,
        plugin_root: PathBuf,
        installed_root: PathBuf,
        legacy_skills_root: PathBuf,
    },
    Unhide {
        id: String,
        plugin_root: PathBuf,
    },
    Cleanup {
        roots: Vec<PathBuf>,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Deleted { warnings: Vec<String> },
    Updated,
    Cleaned { warnings: Vec<String> },
    NeedsHost,
    Failed { message: String },
}

pub fn update(action: Action) -> Reply {
    let result = match action {
        Action::Delete {
            id,
            roots,
            plugin_root,
            installed_root,
            legacy_skills_root,
        } => delete(
            &id,
            &roots,
            &plugin_root,
            &installed_root,
            &legacy_skills_root,
        ),
        Action::Unhide { id, plugin_root } => {
            set_hidden(&plugin_root, &id, false).map(|()| Reply::Updated)
        }
        Action::Cleanup { roots } => Ok(Reply::Cleaned {
            warnings: cleanup(&roots),
        }),
    };
    match result {
        Ok(reply) => reply,
        Err(error) if is_unsupported(error.as_ref()) => Reply::NeedsHost,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

fn set_hidden(plugin_root: &Path, id: &str, hidden: bool) -> Result<()> {
    let root = real_directory(plugin_root)?;
    let request = plugin_config::Target::connector_hidden(root.clone());
    let plugin_config::Reply::Observed { text, version } = plugin_config::read(request) else {
        return Err("无法读取连接器隐藏记录".into());
    };
    let id = id.to_lowercase();
    let mut ids: BTreeSet<String> = text
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.to_lowercase())
        .collect();
    let changed = if hidden {
        ids.insert(id)
    } else {
        ids.remove(&id)
    };
    if !changed {
        return Ok(());
    }
    let request = plugin_config::Target::connector_hidden(root);
    match plugin_config::replace(request, &version, &serde_json::to_string_pretty(&ids)?) {
        plugin_config::Reply::Saved => Ok(()),
        plugin_config::Reply::Failed { message } => Err(message.into()),
        _ => Err("连接器隐藏记录已变化，请刷新后重试".into()),
    }
}

fn package(roots: &[PathBuf], id: &str) -> Result<Option<(PathBuf, PathBuf)>> {
    let id = id.to_lowercase();
    for root in roots {
        let entries = match directories(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if let Some((_, path)) = entries
            .into_iter()
            .find(|(name, _)| name.to_lowercase() == id)
        {
            let root_path =
                real_directory(root).map_err(|error| format!("无法验证连接器市场目录：{error}"))?;
            let package_path =
                real_directory(&path).map_err(|error| format!("无法验证连接器包：{error}"))?;
            if !same_path(root, &root_path)
                || !same_path(&path, &package_path)
                || package_path.parent() != Some(root_path.as_path())
            {
                return Err("拒绝删除市场外的连接器包".into());
            }
            return Ok(Some((root_path, package_path)));
        }
    }
    Ok(None)
}

fn retire_root(root: &Path) -> Result<PathBuf> {
    Ok(root
        .parent()
        .ok_or("连接器市场没有父目录")?
        .join(RETIRED_DIRECTORY))
}

fn uninstall(installed: &Path, skills: &Path, id: &str, warnings: &mut Vec<String>) -> Result<()> {
    match connector_install::uninstall(installed, skills, id)? {
        connector_install::Reply::Uninstalled { warning } => warnings.extend(warning),
        connector_install::Reply::Missing => {}
        _ => return Err("连接器卸载未完成".into()),
    }
    Ok(())
}

fn delete(
    id: &str,
    roots: &[PathBuf],
    plugins: &Path,
    installed: &Path,
    skills: &Path,
) -> Result<Reply> {
    let id = id.trim();
    if id.is_empty() {
        return Err("连接器 id 为空".into());
    }
    let mut warnings = Vec::new();
    if let Some((market, package)) = package(roots, id)? {
        delete_package(&market, &package, id, installed, skills, &mut warnings)?;
    } else {
        // Validate the hidden registry before removing a remaining installation.
        set_hidden(plugins, id, true)?;
        uninstall(installed, skills, id, &mut warnings)
            .map_err(|error| format!("隐藏记录已保存，卸载未完成：{error}"))?;
    }
    Ok(Reply::Deleted { warnings })
}

fn delete_package(
    market: &Path,
    package: &Path,
    id: &str,
    installed: &Path,
    skills: &Path,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let retired = retire_root(market)?;
    match fs::create_dir(&retired) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let retired =
        real_directory(&retired).map_err(|error| format!("无法验证待清理目录：{error}"))?;
    let ticket = retired.join(format!(
        "package-{}-{}",
        std::process::id(),
        NEXT_TICKET.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&ticket)?;
    let result = (|| -> Result<()> {
        let before_uninstall = Handle::from_path(package)?;
        uninstall(installed, skills, id, warnings)?;
        if Handle::from_path(package)? != before_uninstall {
            return Err("连接器包已变化，请刷新后重试".into());
        }
        drop(before_uninstall);
        fs::rename(package, ticket.join("source"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir(&ticket);
        let _ = fs::remove_dir(&retired);
        return Err(error);
    }
    if let Err(error) = fs::remove_dir_all(&ticket) {
        warnings.push(format!("市场包待清理：{error}"));
    }
    let _ = fs::remove_dir(&retired);
    Ok(())
}

fn cleanup(roots: &[PathBuf]) -> Vec<String> {
    let mut warnings = Vec::new();
    for root in roots {
        let result = (|| -> Result<()> {
            let retired = retire_root(root)?;
            if !retired.exists() {
                return Ok(());
            }
            let market = real_directory(root)?;
            if !same_path(root, &market) {
                return Err("拒绝清理重定向市场的待删目录".into());
            }
            let retired = real_directory(&retire_root(&market)?)?;
            for (name, ticket) in directories(&retired)? {
                if name
                    .strip_prefix("package-")
                    .and_then(|name| name.split_once('-'))
                    .is_some_and(|(pid, sequence)| {
                        pid.parse::<u32>().is_ok() && sequence.parse::<u64>().is_ok()
                    })
                {
                    if let Err(error) = real_directory(&ticket)
                        .and_then(|ticket| fs::remove_dir_all(ticket).map_err(Into::into))
                    {
                        warnings.push(format!("{name}: {error}"));
                    }
                }
            }
            let _ = fs::remove_dir(&retired);
            Ok(())
        })();
        if let Err(error) = result {
            warnings.push(error.to_string());
        }
    }
    warnings
}
