use base64::prelude::{Engine as _, BASE64_STANDARD};
use git2::{DiffOptions, ErrorCode, ObjectType, Repository, Signature, Sort, Tree};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
struct CommitHistoryEntry {
    sha: String,
    short_sha: String,
    summary: String,
    author: String,
    time: i64,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProjectSummary {
    name: String,
    modified_at: u64,
    thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct CommitDiffFile {
    path: String,
    old_path: Option<String>,
    new_path: Option<String>,
    status: String,
    is_stl: bool,
    geometry_changed: bool,
}

#[derive(Debug, Serialize)]
struct ManifestDiffEntry {
    path: String,
    change_type: String,
    old_value: Option<Value>,
    new_value: Option<Value>,
    message: String,
}

#[derive(Debug, Serialize)]
struct CommitDiffResponse {
    base_sha: String,
    head_sha: String,
    files: Vec<CommitDiffFile>,
    geometry_changed: bool,
    manifest_diff: Vec<ManifestDiffEntry>,
}

fn open_repository(repo_path: &str) -> Result<Repository, String> {
    Repository::open(repo_path)
        .map_err(|error| format!("Failed to open repository at \"{repo_path}\": {error}"))
}

fn sanitize_project_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => character,
            _ => '_',
        })
        .collect::<String>();

    if sanitized.trim_matches('_').is_empty() {
        "assembly-project".to_string()
    } else {
        sanitized
    }
}

fn resolve_project_directory(app: &AppHandle, project_name: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    Ok(app_data_dir
        .join("STL_Viewer_Projects")
        .join(sanitize_project_segment(project_name)))
}

fn write_thumbnail_png(
    project_dir: &Path,
    thumbnail_base64: Option<&str>,
) -> Result<(), String> {
    let Some(thumbnail_base64) = thumbnail_base64
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let encoded_payload = thumbnail_base64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(thumbnail_base64);
    let image_bytes = BASE64_STANDARD
        .decode(encoded_payload)
        .map_err(|error| format!("Failed to decode thumbnail.png payload: {error}"))?;
    let thumbnail_path = project_dir.join("thumbnail.png");

    fs::write(&thumbnail_path, image_bytes).map_err(|error| {
        format!(
            "Failed to write thumbnail image to \"{}\": {error}",
            thumbnail_path.display()
        )
    })?;

    Ok(())
}

fn modified_time_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified_at| modified_at.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn resolve_project_display_name(project_dir_name: &str, manifest_path: &Path) -> String {
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|manifest| {
            manifest
                .get("projectName")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| project_dir_name.to_string())
}

fn resolve_commit<'repo>(
    repository: &'repo Repository,
    revision: &str,
) -> Result<git2::Commit<'repo>, String> {
    repository
        .revparse_single(revision)
        .and_then(|object| object.peel_to_commit())
        .map_err(|error| format!("Failed to resolve commit \"{revision}\": {error}"))
}

fn normalize_repo_relative_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn relative_path_from_delta(delta: &git2::DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn read_blob_bytes_from_tree(
    repository: &Repository,
    tree: &Tree<'_>,
    path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let normalized_path = normalize_repo_relative_path(path);

    let entry = match tree.get_path(Path::new(&normalized_path)) {
        Ok(entry) => entry,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to locate \"{normalized_path}\" in commit tree: {error}"
            ));
        }
    };

    if entry.kind() != Some(ObjectType::Blob) {
        return Ok(None);
    }

    let blob = repository
        .find_blob(entry.id())
        .map_err(|error| format!("Failed to read blob for \"{normalized_path}\": {error}"))?;

    Ok(Some(blob.content().to_vec()))
}

fn parse_manifest_value(bytes: Option<Vec<u8>>) -> Result<Option<Value>, String> {
    let Some(bytes) = bytes else {
        return Ok(None);
    };

    serde_json::from_slice::<Value>(&bytes)
        .map(Some)
        .map_err(|error| format!("Failed to parse manifest.json: {error}"))
}

fn append_path(path: &str, next: &str) -> String {
    if path.is_empty() {
        next.to_string()
    } else {
        format!("{path}.{next}")
    }
}

fn summarize_value(value: &Value) -> String {
    match value {
        Value::String(value) => format!("{value:?}"),
        _ => value.to_string(),
    }
}

fn build_manifest_diff_entry(
    path: &str,
    old_value: Option<Value>,
    new_value: Option<Value>,
) -> ManifestDiffEntry {
    let display_path = if path.is_empty() { "manifest" } else { path };
    let change_type = match (&old_value, &new_value) {
        (None, Some(_)) => "added",
        (Some(_), None) => "removed",
        _ => "modified",
    }
    .to_string();

    let message = match (&old_value, &new_value) {
        (None, Some(new_value)) => {
            format!("{display_path} added with {}", summarize_value(new_value))
        }
        (Some(old_value), None) => {
            format!(
                "{display_path} removed (was {})",
                summarize_value(old_value)
            )
        }
        (Some(old_value), Some(new_value)) => format!(
            "{display_path} changed from {} to {}",
            summarize_value(old_value),
            summarize_value(new_value)
        ),
        (None, None) => format!("{display_path} changed"),
    };

    ManifestDiffEntry {
        path: display_path.to_string(),
        change_type,
        old_value,
        new_value,
        message,
    }
}

fn values_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn as_object_map(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_array_slice(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

fn manifest_item_key(value: &Value) -> Option<String> {
    value
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn manifest_item_label(value: &Value) -> Option<String> {
    value
        .get("name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| manifest_item_key(value))
}

fn is_manifest_item_array(values: &[Value]) -> bool {
    !values.is_empty()
        && values
            .iter()
            .all(|value| manifest_item_key(value).is_some())
}

fn compare_manifest_values(
    old_value: Option<&Value>,
    new_value: Option<&Value>,
    path: &str,
    deltas: &mut Vec<ManifestDiffEntry>,
) {
    if values_equal(old_value, new_value) {
        return;
    }

    if let (Some(old_object), Some(new_object)) =
        (as_object_map(old_value), as_object_map(new_value))
    {
        let mut keys = BTreeSet::new();
        keys.extend(old_object.keys().cloned());
        keys.extend(new_object.keys().cloned());

        for key in keys {
            compare_manifest_values(
                old_object.get(&key),
                new_object.get(&key),
                &append_path(path, &key),
                deltas,
            );
        }

        return;
    }

    if let (Some(old_array), Some(new_array)) =
        (as_array_slice(old_value), as_array_slice(new_value))
    {
        if (path.ends_with(".position") || path.ends_with(".rotation"))
            && old_array.len() == 3
            && new_array.len() == 3
        {
            for (index, axis) in ["x", "y", "z"].iter().enumerate() {
                compare_manifest_values(
                    old_array.get(index),
                    new_array.get(index),
                    &append_path(path, axis),
                    deltas,
                );
            }

            return;
        }

        if path == "items"
            && (is_manifest_item_array(old_array) || is_manifest_item_array(new_array))
        {
            let old_items = old_array
                .iter()
                .filter_map(|value| manifest_item_key(value).map(|key| (key, value)))
                .collect::<BTreeMap<_, _>>();
            let new_items = new_array
                .iter()
                .filter_map(|value| manifest_item_key(value).map(|key| (key, value)))
                .collect::<BTreeMap<_, _>>();

            let mut keys = BTreeSet::new();
            keys.extend(old_items.keys().cloned());
            keys.extend(new_items.keys().cloned());

            for key in keys {
                let old_item = old_items.get(&key).copied();
                let new_item = new_items.get(&key).copied();
                let label = new_item
                    .and_then(|value| manifest_item_label(value))
                    .or_else(|| old_item.and_then(|value| manifest_item_label(value)))
                    .unwrap_or(key.clone());
                compare_manifest_values(old_item, new_item, &format!("{path}[{label}]"), deltas);
            }

            return;
        }

        let max_len = old_array.len().max(new_array.len());
        for index in 0..max_len {
            compare_manifest_values(
                old_array.get(index),
                new_array.get(index),
                &format!("{path}[{index}]"),
                deltas,
            );
        }

        return;
    }

    deltas.push(build_manifest_diff_entry(
        path,
        old_value.cloned(),
        new_value.cloned(),
    ));
}

fn collect_manifest_diff(
    base_manifest: Option<Value>,
    head_manifest: Option<Value>,
) -> Vec<ManifestDiffEntry> {
    let mut deltas = Vec::new();
    compare_manifest_values(
        base_manifest.as_ref(),
        head_manifest.as_ref(),
        "",
        &mut deltas,
    );

    deltas.into_iter().collect()
}

fn delta_status_name(delta: git2::Delta) -> String {
    match delta {
        git2::Delta::Added => "added",
        git2::Delta::Deleted => "deleted",
        _ => "modified",
    }
    .to_string()
}

#[tauri::command]
fn commit_assembly(
    app: AppHandle,
    project_name: String,
    message: String,
    thumbnail_base64: Option<String>,
) -> Result<bool, String> {
    let project_dir = resolve_project_directory(&app, &project_name)?;
    fs::create_dir_all(&project_dir).map_err(|error| {
        format!(
            "Failed to create project directory \"{}\": {error}",
            project_dir.display()
        )
    })?;
    write_thumbnail_png(&project_dir, thumbnail_base64.as_deref())?;

    let repository = Repository::init(&project_dir).map_err(|error| {
        format!(
            "Failed to initialize repository at \"{}\": {error}",
            project_dir.display()
        )
    })?;

    let mut index = repository
        .index()
        .map_err(|error| format!("Failed to open repository index: {error}"))?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|error| format!("Failed to stage files: {error}"))?;
    index
        .add_path(Path::new("manifest.json"))
        .map_err(|error| format!("Failed to stage manifest.json: {error}"))?;
    if project_dir.join("thumbnail.png").is_file() {
        index
            .add_path(Path::new("thumbnail.png"))
            .map_err(|error| format!("Failed to stage thumbnail.png: {error}"))?;
    }
    index
        .update_all(["*"].iter(), None)
        .map_err(|error| format!("Failed to refresh tracked files in the index: {error}"))?;
    index
        .write()
        .map_err(|error| format!("Failed to write repository index: {error}"))?;

    let tree_id = index
        .write_tree()
        .map_err(|error| format!("Failed to write index tree: {error}"))?;
    let tree = repository
        .find_tree(tree_id)
        .map_err(|error| format!("Failed to look up written tree: {error}"))?;

    let signature = Signature::now("STL Viewer", "auto@local")
        .map_err(|error| format!("Failed to create commit signature: {error}"))?;
    let head_commit = repository
        .head()
        .ok()
        .and_then(|head| head.target())
        .map(|oid| repository.find_commit(oid))
        .transpose()
        .map_err(|error| format!("Failed to resolve HEAD commit: {error}"))?;
    let parent_commits = head_commit.iter().collect::<Vec<_>>();

    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            &message,
            &tree,
            &parent_commits,
        )
        .map_err(|error| format!("Failed to create commit: {error}"))?;

    Ok(true)
}

#[tauri::command]
fn get_commit_history(repo_path: String) -> Result<Vec<CommitHistoryEntry>, String> {
    let repository = open_repository(&repo_path)?;
    let mut revwalk = repository
        .revwalk()
        .map_err(|error| format!("Failed to create revwalk: {error}"))?;
    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|error| format!("Failed to configure revwalk: {error}"))?;
    revwalk
        .push_head()
        .map_err(|error| format!("Failed to walk HEAD history: {error}"))?;

    let mut entries = Vec::new();
    for oid in revwalk.take(100) {
        let oid = oid.map_err(|error| format!("Failed to read commit id: {error}"))?;
        let commit = repository
            .find_commit(oid)
            .map_err(|error| format!("Failed to load commit \"{oid}\": {error}"))?;
        let sha = commit.id().to_string();
        let short_sha = sha.chars().take(7).collect::<String>();
        let author = commit.author().name().unwrap_or("Unknown").to_string();
        let summary = commit.summary().unwrap_or("No commit message").to_string();

        entries.push(CommitHistoryEntry {
            label: format!("{short_sha} - {author}: {summary}"),
            sha,
            short_sha,
            summary,
            author,
            time: commit.time().seconds(),
        });
    }

    Ok(entries)
}

#[tauri::command]
fn get_local_projects(app: AppHandle) -> Result<Vec<LocalProjectSummary>, String> {
    let projects_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("STL_Viewer_Projects");

    if !projects_root.exists() {
        return Ok(Vec::new());
    }

    let directory_entries = fs::read_dir(&projects_root).map_err(|error| {
        format!(
            "Failed to read projects directory \"{}\": {error}",
            projects_root.display()
        )
    })?;

    let mut projects = Vec::new();

    for entry in directory_entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }

        let manifest_path = project_path.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }

        if !project_path.join("parts").is_dir() {
            continue;
        }

        let thumbnail_path = project_path.join("thumbnail.png");

        let project_dir_name = entry.file_name().to_string_lossy().to_string();
        projects.push(LocalProjectSummary {
            name: resolve_project_display_name(&project_dir_name, &manifest_path),
            modified_at: modified_time_millis(&manifest_path),
            thumbnail_path: thumbnail_path
                .is_file()
                .then(|| thumbnail_path.to_string_lossy().to_string()),
        });
    }

    projects.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(projects)
}

#[tauri::command]
fn get_file_at_sha(repo_path: String, sha: String, file_path: String) -> Result<Vec<u8>, String> {
    let repository = open_repository(&repo_path)?;
    let commit = resolve_commit(&repository, &sha)?;
    let tree = commit
        .tree()
        .map_err(|error| format!("Failed to resolve tree for \"{sha}\": {error}"))?;

    read_blob_bytes_from_tree(&repository, &tree, &file_path)?.ok_or_else(|| {
        format!(
            "\"{}\" does not exist in commit \"{}\"",
            normalize_repo_relative_path(&file_path),
            sha
        )
    })
}

#[tauri::command]
fn get_commit_diff(
    repo_path: String,
    base_sha: String,
    head_sha: String,
) -> Result<CommitDiffResponse, String> {
    let repository = open_repository(&repo_path)?;
    let base_commit = resolve_commit(&repository, &base_sha)?;
    let head_commit = resolve_commit(&repository, &head_sha)?;
    let base_tree = base_commit
        .tree()
        .map_err(|error| format!("Failed to resolve tree for \"{base_sha}\": {error}"))?;
    let head_tree = head_commit
        .tree()
        .map_err(|error| format!("Failed to resolve tree for \"{head_sha}\": {error}"))?;

    let mut diff_options = DiffOptions::new();
    diff_options.include_typechange(true);

    let diff = repository
        .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut diff_options))
        .map_err(|error| format!("Failed to diff commits: {error}"))?;

    let files = diff
        .deltas()
        .map(|delta| {
            let old_path = delta
                .old_file()
                .path()
                .map(|path| path.to_string_lossy().replace('\\', "/"));
            let new_path = delta
                .new_file()
                .path()
                .map(|path| path.to_string_lossy().replace('\\', "/"));
            let path = relative_path_from_delta(&delta)
                .ok_or_else(|| "Encountered a diff entry without a file path.".to_string())?;
            let is_stl = path.to_ascii_lowercase().ends_with(".stl");

            let geometry_changed = if !is_stl {
                false
            } else {
                let old_blob = old_path
                    .as_deref()
                    .map(|path| read_blob_bytes_from_tree(&repository, &base_tree, path))
                    .transpose()?;
                let new_blob = new_path
                    .as_deref()
                    .map(|path| read_blob_bytes_from_tree(&repository, &head_tree, path))
                    .transpose()?;

                match (old_blob, new_blob) {
                    (Some(old_blob), Some(new_blob)) => old_blob != new_blob,
                    (Some(_), None) | (None, Some(_)) => true,
                    (None, None) => false,
                }
            };

            Ok(CommitDiffFile {
                path,
                old_path,
                new_path,
                status: delta_status_name(delta.status()),
                is_stl,
                geometry_changed,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let base_manifest = parse_manifest_value(read_blob_bytes_from_tree(
        &repository,
        &base_tree,
        "manifest.json",
    )?)?;
    let head_manifest = parse_manifest_value(read_blob_bytes_from_tree(
        &repository,
        &head_tree,
        "manifest.json",
    )?)?;
    let manifest_diff = collect_manifest_diff(base_manifest, head_manifest);
    let geometry_changed = files
        .iter()
        .any(|file| file.is_stl && file.geometry_changed);

    Ok(CommitDiffResponse {
        base_sha,
        head_sha,
        files,
        geometry_changed,
        manifest_diff,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commit_assembly,
            get_commit_diff,
            get_commit_history,
            get_file_at_sha,
            get_local_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
