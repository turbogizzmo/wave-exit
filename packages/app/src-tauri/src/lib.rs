//! Wave Exit's native side. Deliberately small: private project storage in the app
//! data folder (the app encrypts everything before it gets here), the OS keychain,
//! and file access limited to what the user picked or dropped. The web side can't
//! read or write any other file.

use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, DragDropEvent, Manager, State, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const KEYCHAIN_SERVICE: &str = "Wave Exit";
const MAX_INPUT_FILES: usize = 20_000;
const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Paths the user has handed over (picked in a dialog or dropped on the window).
#[derive(Default)]
struct Granted {
    inputs: Mutex<HashSet<PathBuf>>,
    /// Files found under granted inputs, which `read_input_file` may read.
    readable: Mutex<HashSet<PathBuf>>,
    output_folders: Mutex<HashSet<PathBuf>>,
}

type Res<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn header(req: &Request, name: &str) -> Res<String> {
    let v = req.headers().get(name).ok_or_else(|| format!("missing {name}"))?;
    let s = v.to_str().map_err(err)?;
    Ok(percent_decode_str(s).decode_utf8().map_err(err)?.into_owned())
}

fn raw_body<'a>(req: &'a Request<'a>) -> Res<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected raw bytes".into()),
    }
}

// ---- storage ------------------------------------------------------------------

fn storage_root(app: &AppHandle) -> Res<PathBuf> {
    let d = app.path().app_data_dir().map_err(err)?.join("projects");
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

/// Join a relative storage path, refusing anything that could leave the root.
fn safe_join(root: &Path, rel: &str) -> Res<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("bad storage path {rel:?}"));
    }
    Ok(root.join(p))
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) -> Res<()> {
    for e in fs::read_dir(dir).map_err(err)? {
        let e = e.map_err(err)?;
        let p = e.path();
        if p.is_dir() {
            walk(&p, base, out)?;
        } else if p.extension().map_or(true, |x| x != "tmp") {
            let rel = p.strip_prefix(base).map_err(err)?;
            out.push(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"));
        }
    }
    Ok(())
}

#[tauri::command]
fn storage_list(app: AppHandle) -> Res<Vec<String>> {
    let root = storage_root(&app)?;
    let mut out = Vec::new();
    walk(&root, &root, &mut out)?;
    out.sort();
    Ok(out)
}

/// Empty response means "not there" (stored files are never empty: they are sealed).
#[tauri::command]
fn storage_read(app: AppHandle, path: String) -> Res<Response> {
    let p = safe_join(&storage_root(&app)?, &path)?;
    match fs::read(&p) {
        Ok(b) => Ok(Response::new(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Response::new(Vec::new())),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn storage_write(app: AppHandle, request: Request<'_>) -> Res<()> {
    let p = safe_join(&storage_root(&app)?, &header(&request, "x-path")?)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    // Write then rename, so a crash never leaves half a file.
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, raw_body(&request)?).map_err(err)?;
    fs::rename(&tmp, &p).map_err(err)
}

#[tauri::command]
fn storage_remove_project(app: AppHandle, project_id: String) -> Res<()> {
    if project_id.is_empty() || !project_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad project id".into());
    }
    let p = storage_root(&app)?.join(&project_id);
    if p.exists() {
        fs::remove_dir_all(p).map_err(err)?;
    }
    Ok(())
}

// ---- keychain -----------------------------------------------------------------

fn entry(name: &str) -> Res<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(err)
}

#[tauri::command]
fn keychain_get(name: String) -> Res<Option<String>> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn keychain_set(name: String, value: String) -> Res<()> {
    entry(&name)?.set_password(&value).map_err(err)
}

#[tauri::command]
fn keychain_remove(name: String) -> Res<()> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}

// ---- inputs -------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFile {
    /// Relative to what was picked: "export/accounting.csv", or just the file name.
    path: String,
    absolute: String,
    modified_ms: Option<u64>,
    size: u64,
}

fn collect(path: &Path, rel: String, out: &mut Vec<NativeFile>, total: &mut u64) -> Res<()> {
    let meta = fs::metadata(path).map_err(err)?;
    if meta.is_dir() {
        let mut entries: Vec<_> = fs::read_dir(path).map_err(err)?.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }
            collect(&e.path(), format!("{rel}/{name}"), out, total)?;
        }
        return Ok(());
    }
    *total += meta.len();
    if out.len() >= MAX_INPUT_FILES || *total > MAX_INPUT_BYTES {
        return Err("Too many files, or too large, to read at once.".into());
    }
    out.push(NativeFile {
        path: rel,
        absolute: path.to_string_lossy().into_owned(),
        modified_ms: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
        size: meta.len(),
    });
    Ok(())
}

fn list_granted(granted: &Granted, paths: &[PathBuf]) -> Res<Vec<NativeFile>> {
    let allowed = granted.inputs.lock().map_err(err)?;
    let mut out = Vec::new();
    let mut total = 0;
    for p in paths {
        if !allowed.contains(p) {
            return Err("That file wasn't chosen or dropped in this window.".into());
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        collect(p, name, &mut out, &mut total)?;
    }
    granted.readable.lock().map_err(err)?.extend(out.iter().map(|f| PathBuf::from(&f.absolute)));
    Ok(out)
}

/// Show the open dialog, and grant what the user chose.
#[tauri::command]
fn pick_input(app: AppHandle, granted: State<'_, Granted>, folder: bool) -> Res<Vec<NativeFile>> {
    let dialog = app.dialog().file().set_title(if folder { "Choose the unzipped Wave export folder" } else { "Choose Wave export files" });
    let picked: Vec<PathBuf> = if folder {
        dialog.blocking_pick_folder().into_iter().filter_map(|p| p.into_path().ok()).collect()
    } else {
        dialog.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
    };
    granted.inputs.lock().map_err(err)?.extend(picked.iter().cloned());
    list_granted(&granted, &picked)
}

/// List files under paths that were dropped on the window (recorded natively, below).
#[tauri::command]
fn list_dropped(granted: State<'_, Granted>, paths: Vec<String>) -> Res<Vec<NativeFile>> {
    list_granted(&granted, &paths.into_iter().map(PathBuf::from).collect::<Vec<_>>())
}

#[tauri::command]
fn read_input_file(granted: State<'_, Granted>, path: String) -> Res<Response> {
    let p = PathBuf::from(&path);
    if !granted.readable.lock().map_err(err)?.contains(&p) {
        return Err("That file wasn't chosen or dropped in this window.".into());
    }
    Ok(Response::new(fs::read(p).map_err(err)?))
}

// ---- outputs ------------------------------------------------------------------

#[tauri::command]
fn pick_output_folder(app: AppHandle, granted: State<'_, Granted>) -> Res<Option<String>> {
    let picked = app.dialog().file().set_title("Choose where to save the outputs").blocking_pick_folder();
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    granted.output_folders.lock().map_err(err)?.insert(p.clone());
    Ok(Some(p.to_string_lossy().into_owned()))
}

/// Write one output into a folder the user chose. Never overwrites: adds " (2)", " (3)"….
#[tauri::command]
fn write_output(granted: State<'_, Granted>, request: Request<'_>) -> Res<String> {
    let folder = PathBuf::from(header(&request, "x-folder")?);
    if !granted.output_folders.lock().map_err(err)?.contains(&folder) {
        return Err("That folder wasn't chosen in this window.".into());
    }
    let name = header(&request, "x-name")?;
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(format!("bad file name {name:?}"));
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    let mut target = folder.join(&name);
    let mut n = 2;
    while target.exists() {
        target = folder.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    fs::write(&target, raw_body(&request)?).map_err(err)?;
    Ok(target.to_string_lossy().into_owned())
}

// ---- QuickBooks sign-in -----------------------------------------------------------

/// The local address Intuit redirects to after sign-in. It must match the redirect
/// URI registered on the Intuit app exactly (Intuit allows http://localhost only for
/// sandbox/development keys; production uses the token-exchange service's https page).
const INTUIT_LOOPBACK_PORT: u16 = 53682;

/// Open Intuit's sign-in page in the user's browser, wait (up to 5 minutes) for the
/// redirect on localhost, and return its URL. Only Intuit's own sign-in address is opened.
#[tauri::command]
async fn intuit_sign_in(app: AppHandle, authorize_url: String) -> Res<String> {
    use tauri_plugin_opener::OpenerExt;
    if !authorize_url.starts_with("https://appcenter.intuit.com/connect/oauth2?") {
        return Err("not an Intuit sign-in address".into());
    }
    let listeners: Vec<std::net::TcpListener> = ["127.0.0.1", "[::1]"]
        .iter()
        .filter_map(|h| std::net::TcpListener::bind(format!("{h}:{INTUIT_LOOPBACK_PORT}")).ok())
        .collect();
    if listeners.is_empty() {
        return Err(format!("Port {INTUIT_LOOPBACK_PORT} is in use by another program, so the QuickBooks sign-in reply can't be received. Close it and try again."));
    }
    for l in &listeners {
        l.set_nonblocking(true).map_err(err)?;
    }
    app.opener().open_url(&authorize_url, None::<&str>).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || wait_for_callback(listeners))
        .await
        .map_err(err)?
}

fn wait_for_callback(listeners: Vec<std::net::TcpListener>) -> Res<String> {
    use std::io::{Read, Write};
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    while std::time::Instant::now() < deadline {
        for l in &listeners {
            let Ok((mut stream, _)) = l.accept() else { continue };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            let path = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
            if !path.starts_with("/callback?") {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            let ok = !path.contains("error=");
            let body = format!(
                "<!doctype html><meta charset=utf-8><title>Wave Exit</title><body style=\"font:16px -apple-system,Segoe UI,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px\"><h1>{}</h1><p>{}</p></body>",
                if ok { "Connected to QuickBooks" } else { "QuickBooks didn't connect" },
                if ok { "You can close this tab and go back to Wave Exit." } else { "Go back to Wave Exit to see what happened and try again." }
            );
            let _ = stream.write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes(),
            );
            return Ok(format!("http://localhost:{INTUIT_LOOPBACK_PORT}{path}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("No reply from QuickBooks within 5 minutes. Try connecting again.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Granted::default())
        .on_window_event(|window, event| {
            // Record dropped paths natively, so the web side can only list what the user really dropped.
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                if let Ok(mut g) = window.state::<Granted>().inputs.lock() {
                    g.extend(paths.iter().cloned());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            storage_list,
            storage_read,
            storage_write,
            storage_remove_project,
            keychain_get,
            keychain_set,
            keychain_remove,
            pick_input,
            list_dropped,
            read_input_file,
            pick_output_folder,
            write_output,
            intuit_sign_in
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wave Exit");
}
