mod audio;
mod db;
mod dropbox;
mod licensing;
mod models;
mod waveform;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("no app data dir");
            let conn = db::init(&app_data_dir).expect("failed to init database");
            app.manage(db::DbState(parking_lot::Mutex::new(conn)));
            app.manage(audio::AudioState(parking_lot::Mutex::new(
                audio::AudioPlayer::default(),
            )));
            app.manage(dropbox::DropboxState(parking_lot::Mutex::new(
                dropbox::DropboxTokenCache::default(),
            )));
            audio::start_status_emitter(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::list_projects,
            db::create_project,
            db::set_project_cover_style,
            db::set_project_cover_image,
            db::set_track_cover_image,
            db::get_project_detail,
            db::import_local_files,
            db::import_grouped_files,
            db::list_versions,
            db::set_default_version,
            db::list_playlists,
            db::create_playlist,
            db::add_to_playlist,
            db::list_favorites,
            db::toggle_favorite,
            waveform::generate_peaks_cmd,
            audio::audio_load,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_seek,
            audio::audio_set_volume,
            audio::audio_get_status,
            dropbox::dropbox_connect,
            dropbox::dropbox_get_connection,
            dropbox::dropbox_disconnect,
            dropbox::dropbox_list_app_folder,
            dropbox::dropbox_import_file,
            dropbox::dropbox_upload_version,
            dropbox::dropbox_get_refresh_token,
            licensing::license_activate,
            licensing::license_get,
            licensing::license_validate,
            licensing::license_deactivate,
            licensing::auth_wait_for_email_link_callback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
