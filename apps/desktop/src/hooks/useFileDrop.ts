import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const AUDIO_EXTENSIONS = ["mp3", "wav", "aiff", "flac", "m4a", "aac"];

function isAudioPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return !!ext && AUDIO_EXTENSIONS.includes(ext);
}

export type FileDropState = "idle" | "hover";

interface UseFileDropOptions {
  /** Called with the audio-filtered paths once the user actually drops files (non-audio paths are silently ignored). */
  onDropFiles: (paths: string[]) => void;
  /** When false, the listener is torn down and hover state stays idle — e.g. while no project is selected. */
  enabled?: boolean;
}

/**
 * Registers Tauri's window-level drag-drop listener for real OS drag-and-drop
 * of files from Finder. Tauri's webview intercepts plain HTML5 `ondrop` by
 * default, so `getCurrentWebviewWindow().onDragDropEvent(...)` is the actual
 * way to observe this — see the `DragDropEvent` union in
 * `@tauri-apps/api/webview` (`enter` | `over` | `drop` | `leave`; `enter`
 * and `drop` carry `paths`, `over`/`leave` don't).
 *
 * Returns "hover" while a drag carrying files is over the window so callers
 * can render a "drop here" overlay, and "idle" otherwise.
 */
export function useFileDrop({ onDropFiles, enabled = true }: UseFileDropOptions): FileDropState {
  const [state, setState] = useState<FileDropState>("idle");

  useEffect(() => {
    if (!enabled) {
      setState("idle");
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setState("hover");
        } else if (payload.type === "drop") {
          setState("idle");
          const audioPaths = payload.paths.filter(isAudioPath);
          if (audioPaths.length > 0) onDropFiles(audioPaths);
        } else {
          // "leave"
          setState("idle");
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* drag-drop event not available in this environment — non-fatal */
      });

    return () => {
      cancelled = true;
      unlisten?.();
      setState("idle");
    };
  }, [enabled, onDropFiles]);

  return state;
}
