#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use lofty::file::TaggedFileExt;
use lofty::picture::PictureType;
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

const AUDIO_EXTS: [&str; 7] = ["mp3", "flac", "m4a", "ogg", "oga", "opus", "wav"];

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    folders: Vec<String>,
    min_duration_secs: u64,
    min_size_bytes: u64,
    theme: String, // "light" | "dark" | "system"
    adaptive_colors: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            folders: Vec::new(),
            min_duration_secs: 60,
            min_size_bytes: 100 * 1024,
            theme: "system".into(),
            adaptive_colors: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct IndexEntry {
    size: u64,
    mtime: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Index {
    entries: HashMap<String, IndexEntry>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Track {
    id: String,
    path: String,
    title: String,
    artist: String,
    album: String,
    album_artist: String,
    genre: String,
    year: Option<u32>,
    track_no: Option<u32>,
    duration_secs: f32,
    size: u64,
    has_cover: bool,
}

#[derive(Serialize, Clone)]
struct IgnoredFile {
    path: String,
    reason: String,
}

#[derive(Serialize, Clone)]
struct ScanResult {
    tracks: Vec<Track>,
    ignored: Vec<IgnoredFile>,
    added: usize,
    removed: usize,
}

struct AppState {
    covers: Mutex<HashMap<String, Vec<u8>>>,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn read_json<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    if let Ok(bytes) = serde_json::to_vec_pretty(value) {
        let _ = fs::write(path, bytes);
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    let mut s: Settings = read_json(&data_dir(&app).join("settings.json"));
    if s.min_duration_secs == 0 {
        s.min_duration_secs = 60;
    }
    if s.min_size_bytes == 0 {
        s.min_size_bytes = 100 * 1024;
    }
    s
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) {
    write_json(&data_dir(&app).join("settings.json"), &settings);
}

#[tauri::command]
fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|p| p.to_string())
}

#[tauri::command]
fn get_music_dir() -> Option<String> {
    dirs::audio_dir().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_stats(app: AppHandle) -> serde_json::Value {
    read_json(&data_dir(&app).join("stats.json"))
}

#[tauri::command]
fn save_stats(app: AppHandle, stats: serde_json::Value) {
    write_json(&data_dir(&app).join("stats.json"), &stats);
}

fn track_id(path: &str) -> String {
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    let d = h.finalize();
    d.iter().take(12).map(|b| format!("{:02x}", b)).collect()
}

fn probe_duration(path: &Path) -> Option<f32> {
    Probe::open(path)
        .ok()?
        .guess_current()
        .ok()?
        .properties()
        .ok()
        .map(|p| p.duration_secs() as f32)
}

fn extract_tags(
    path: &Path,
    id: &str,
    covers: &mut HashMap<String, Vec<u8>>,
) -> Option<(String, String, String, String, String, Option<u32>, Option<u32>, f32, bool)> {
    let tagged = Probe::open(path).ok()?.guess_current().ok()?;
    let duration = tagged.properties().ok()?.duration_secs() as f32;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let get = |v: Option<&str>| -> String {
        v.map(|t| t.to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_default()
    };
    let title = get(tag.title());
    let artist = get(tag.artist());
    let album = get(tag.album());
    let album_artist = get(tag.album_artist());
    let genre = get(tag.genre());
    let year = tag.year();
    let track_no = tag.track();
    let has_cover = tag
        .get_picture(PictureType::Front)
        .or_else(|| tag.pictures().first().copied())
        .map(|p| {
            covers.insert(id.to_string(), p.data().to_vec());
            true
        })
        .unwrap_or(false);
    Some((
        title, artist, album, album_artist, genre, year, track_no, duration, has_cover,
    ))
}

fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn read_cover_from_file(path: &Path, id: &str, covers: &mut HashMap<String, Vec<u8>>) -> bool {
    let Ok(tagged) = Probe::open(path).and_then(|p| p.guess_current()) else {
        return false;
    };
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        if let Some(pic) = tag
            .get_picture(PictureType::Front)
            .or_else(|| tag.pictures().first().copied())
        {
            covers.insert(id.to_string(), pic.data().to_vec());
            return true;
        }
    }
    false
}

#[tauri::command]
fn scan_library(app: AppHandle, state: State<AppState>) -> ScanResult {
    let settings: Settings = read_json(&data_dir(&app).join("settings.json"));
    let index_path = data_dir(&app).join("index.json");
    let tracks_path = data_dir(&app).join("tracks.json");
    let mut index: Index = read_json(&index_path);
    let mut meta: HashMap<String, Track> = read_json(&tracks_path);

    let mut tracks: Vec<Track> = Vec::new();
    let mut ignored: Vec<IgnoredFile> = Vec::new();
    let mut covers = state.covers.lock().unwrap();
    let mut seen: HashSet<String> = HashSet::new();
    let mut added = 0usize;

    for folder in &settings.folders {
        for entry in WalkDir::new(folder).follow_links(false).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            match path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
                Some(e) if AUDIO_EXTS.contains(&e.as_str()) => {}
                _ => continue,
            }
            let path_str = path.to_string_lossy().into_owned();
            let meta_fs = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = meta_fs.len();
            let mtime = meta_fs
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let id = track_id(&path_str);
            seen.insert(id.clone());

            let fresh = index
                .entries
                .get(&id)
                .map(|c| c.size == size && c.mtime == mtime)
                .unwrap_or(false);

            if fresh {
                if let Some(t) = meta.get(&id) {
                    tracks.push(t.clone());
                    continue;
                }
            }

            if size < settings.min_size_bytes {
                ignored.push(IgnoredFile {
                    path: path_str,
                    reason: format!("Taille < {} Ko", settings.min_size_bytes / 1024),
                });
                continue;
            }
            let duration = match probe_duration(path) {
                Some(d) => d,
                None => {
                    ignored.push(IgnoredFile {
                        path: path_str,
                        reason: "Fichier illisible".into(),
                    });
                    continue;
                }
            };
            if duration < settings.min_duration_secs as f32 {
                ignored.push(IgnoredFile {
                    path: path_str,
                    reason: format!("Durée < {} s", settings.min_duration_secs),
                });
                continue;
            }
            let (title, artist, album, album_artist, genre, year, track_no, _, has_cover) =
                extract_tags(path, &id, &mut covers).unwrap_or_else(|| {
                    (
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                        String::new(),
                        None,
                        None,
                        0.0,
                        false,
                    )
                });
            let title = if title.is_empty() { fallback_title(path) } else { title };
            let artist = if artist.is_empty() { "Artiste inconnu".into() } else { artist };
            let album = if album.is_empty() { "Album inconnu".into() } else { album };
            let track = Track {
                id: id.clone(),
                path: path_str.clone(),
                title,
                artist,
                album,
                album_artist,
                genre,
                year,
                track_no,
                duration_secs: duration,
                size,
                has_cover,
            };
            index.entries.insert(id.clone(), IndexEntry { size, mtime });
            meta.insert(id.clone(), track.clone());
            tracks.push(track);
            added += 1;
        }
    }

    let before = index.entries.len();
    index.entries.retain(|id, _| seen.contains(id));
    let removed = before - index.entries.len();

    meta.retain(|id, _| seen.contains(id));
    write_json(&tracks_path, &meta);
    write_json(&index_path, &index);

    tracks.sort_by(|a, b| {
        a.artist
            .cmp(&b.artist)
            .then(a.album.cmp(&b.album))
            .then(a.track_no.cmp(&b.track_no))
    });

    ScanResult {
        tracks,
        ignored,
        added,
        removed,
    }
}

#[tauri::command]
fn get_cover(app: AppHandle, state: State<AppState>, id: String) -> Option<String> {
    let mut covers = state.covers.lock().unwrap();
    if !covers.contains_key(&id) {
        let meta: HashMap<String, Track> = read_json(&data_dir(&app).join("tracks.json"));
        let track = meta.get(&id)?;
        if !read_cover_from_file(Path::new(&track.path), &id, &mut covers) {
            covers.insert(id.clone(), Vec::new());
            return None;
        }
    }
    covers.get(&id).filter(|d| !d.is_empty()).map(|data| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data)
        )
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState {
                covers: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            pick_folder,
            get_music_dir,
            get_stats,
            save_stats,
            scan_library,
            get_cover
        ])
        .run(tauri::generate_context!())
        .expect("error while running aurora player");
}
