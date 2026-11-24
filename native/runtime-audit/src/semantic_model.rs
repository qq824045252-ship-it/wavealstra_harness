use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    roots: Vec<PathBuf>,
    fallback_root: PathBuf,
    model_id: String,
    model_version: String,
    dimension: usize,
    required_files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    model_id: String,
    model_version: String,
    dimension: usize,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
struct ManifestFile {
    name: String,
    sha256: Option<String>,
    size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Ready,
    NotInstalled,
    Corrupt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    status: Status,
    error: Option<String>,
    models_root: PathBuf,
    revision: Option<String>,
}

#[derive(PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl FileStamp {
    fn new(metadata: &Metadata) -> std::io::Result<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified()?,
            created: metadata.created().ok(),
            #[cfg(unix)]
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        })
    }
}

#[derive(Default)]
pub struct Verifier {
    verified: HashMap<PathBuf, (FileStamp, String)>,
}

impl Verifier {
    pub fn probe(&mut self, request: Probe) -> Installation {
        let mut first_error = None;
        for root in &request.roots {
            if !root.join("manifest.json").exists()
                && !request
                    .required_files
                    .iter()
                    .any(|name| root.join(name).exists())
            {
                continue;
            }
            match self.verify_root(root, &request) {
                Ok(revision) => {
                    return Installation {
                        status: Status::Ready,
                        error: None,
                        models_root: root.clone(),
                        revision: Some(revision),
                    };
                }
                Err(error) => {
                    first_error.get_or_insert_with(|| (root.clone(), error.to_string()));
                }
            }
        }
        match first_error {
            Some((models_root, error)) => Installation {
                status: Status::Corrupt,
                error: Some(error),
                models_root,
                revision: None,
            },
            None => Installation {
                status: Status::NotInstalled,
                error: None,
                models_root: request.fallback_root,
                revision: None,
            },
        }
    }

    fn verify_root(&mut self, root: &Path, request: &Probe) -> Result<String> {
        let bytes =
            fs::read(root.join("manifest.json")).map_err(|_| "manifest.json 缺失或无法读取")?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| "manifest.json 缺失或无法读取")?;
        if manifest.model_id != request.model_id
            || manifest.model_version != request.model_version
            || manifest.dimension != request.dimension
        {
            return Err(format!(
                "模型包与 {} {}（{} 维）不匹配",
                request.model_id, request.model_version, request.dimension
            )
            .into());
        }
        for name in &request.required_files {
            let declared = manifest.files.iter().any(|entry| {
                entry.name == *name
                    && entry.sha256.as_ref().is_some_and(|sha| {
                        sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit())
                    })
            });
            if !declared {
                return Err(format!("manifest.json 缺少 {name} 的 SHA-256").into());
            }
        }
        for entry in manifest.files {
            let name = Path::new(&entry.name);
            if entry.name.is_empty()
                || name
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
            {
                return Err("manifest.json 包含无效的模型文件名".into());
            }
            let path = root.join(name);
            let metadata = fs::metadata(&path).map_err(|_| format!("缺少文件 {}", entry.name))?;
            if !metadata.is_file() || entry.size.is_some_and(|size| metadata.len() != size) {
                return Err(format!("文件大小不匹配：{}", entry.name).into());
            }
            let Some(sha) = entry
                .sha256
                .filter(|sha| !sha.is_empty())
                .map(|sha| sha.to_ascii_lowercase())
            else {
                continue;
            };
            let stamp = FileStamp::new(&metadata)?;
            if self
                .verified
                .get(&path)
                .is_some_and(|(previous, expected)| previous == &stamp && expected == &sha)
            {
                continue;
            }
            let mut file = File::open(&path)?;
            if FileStamp::new(&file.metadata()?)? != stamp {
                return Err(format!("模型文件在校验期间发生变化：{}", entry.name).into());
            }
            let mut hash = Sha256::new();
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            if FileStamp::new(&file.metadata()?)? != stamp
                || FileStamp::new(&fs::metadata(&path)?)? != stamp
            {
                return Err(format!("模型文件在校验期间发生变化：{}", entry.name).into());
            }
            if format!("{:x}", hash.finalize()) != sha {
                return Err(format!("SHA-256 校验失败：{}", entry.name).into());
            }
            self.verified.insert(path, (stamp, sha));
        }
        if fs::read(root.join("manifest.json"))? != bytes {
            return Err("模型清单在校验期间发生变化".into());
        }
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}
