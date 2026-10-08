// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
/*
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
} */
use futures_util::StreamExt;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::io::Read;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum HashEvent {
    Progress {
        bytes_done: u64,
        bytes_total: u64,
    },
    Done {
        crc32: String,
        sha1: String,
        elapsed_ms: u128,
    },
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum DownloadEvent {
    Progress {
        bytes_done: u64,
        bytes_total: Option<u64>,
    },
    Done {
        elapsed_ms: u128,
    },
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            size: meta.len(),
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
async fn hash_file(path: String, on_event: Channel<HashEvent>) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let start = Instant::now();
        let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();

        let mut crc = crc32fast::Hasher::new();
        let mut sha = Sha1::new();
        let mut buf = vec![0u8; 1024 * 1024]; // buffer de 1 MB
        let mut done: u64 = 0;
        let mut last_emit = Instant::now();

        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            crc.update(&buf[..n]);
            sha.update(&buf[..n]);
            done += n as u64;

            if last_emit.elapsed() >= Duration::from_millis(250) {
                let _ = on_event.send(HashEvent::Progress {
                    bytes_done: done,
                    bytes_total: total,
                });
                last_emit = Instant::now();
            }
        }

        let digest = sha.finalize();
        let sha1_hex: String = digest
            .as_slice()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        on_event
            .send(HashEvent::Done {
                crc32: format!("{:08x}", crc.finalize()),
                sha1: sha1_hex,
                elapsed_ms: start.elapsed().as_millis(),
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

#[tauri::command]
async fn download_file(
    url: String,
    dest: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let start = Instant::now();

    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let total = resp.content_length();
    let part_path = format!("{dest}.part");
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = resp.bytes_stream();
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(250) {
            let _ = on_event.send(DownloadEvent::Progress {
                bytes_done: done,
                bytes_total: total,
            });
            last_emit = Instant::now();
        }
    }

    file.flush().await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&part_path, &dest)
        .await
        .map_err(|e| e.to_string())?;

    on_event
        .send(DownloadEvent::Done {
            elapsed_ms: start.elapsed().as_millis(),
        })
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![list_dir, hash_file, download_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
