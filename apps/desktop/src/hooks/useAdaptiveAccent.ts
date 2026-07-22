import { useEffect } from "react";
import type { FileRef } from "@session/shared-types";
import { api } from "../lib/api";

const STORAGE_KEY = "session.adaptiveAccent";

export function isAdaptiveAccentEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistAdaptiveAccentEnabled(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* localStorage unavailable — the toggle just won't survive a restart */
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Plain RGB -> HSL, hue in [0,360), saturation/lightness in [0,100]. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return [h * 60, s * 100, l * 100];
}

function hsl(h: number, s: number, l: number) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

/**
 * Samples the current cover art's average color (via the `sample_cover_color`
 * Rust command — decoding the file directly on disk, not through a `<canvas>`
 * reading a Tauri-asset-protocol `<img>`, which commonly throws a silent
 * tainted-canvas `SecurityError`) and applies it as the app's live accent
 * color set (`--accent` / `--accent-2` / `--accent-ink`) on the document
 * root, overriding the static values from `tokens.css`.
 *
 * The hue and saturation come from the art, but lightness is always pinned
 * to a fixed, pre-chosen band — that's what keeps an accent sampled from
 * *any* cover (a pale acoustic-single cover or a near-black metal one alike)
 * reliably legible against the app's near-black background, rather than
 * needing a true "dominant color" extraction algorithm.
 *
 * Disabling the feature (or having no cover to sample from) clears the
 * inline overrides, which reverts every consumer straight back to
 * `tokens.css`'s static accent — there is no other fallback path to keep in
 * sync.
 */
export function useAdaptiveAccent(cover: FileRef | null | undefined, enabled: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    if (!enabled || !cover?.path) {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-2");
      root.style.removeProperty("--accent-ink");
      return;
    }

    let cancelled = false;
    api
      .sampleCoverColor(cover.path)
      .then(([r, g, b]) => {
        if (cancelled) return;
        const [h, s] = rgbToHsl(r, g, b);
        const bandedSaturation = clamp(s, 45, 85);
        root.style.setProperty("--accent", hsl(h, bandedSaturation, 58));
        root.style.setProperty("--accent-2", hsl((h + 35) % 360, clamp(s, 40, 80), 62));
        root.style.setProperty("--accent-ink", hsl(h, bandedSaturation, 12));
      })
      .catch(() => {
        // Unreadable/unsupported cover file — keep whatever accent is
        // already active rather than erroring out loud.
      });

    return () => {
      cancelled = true;
    };
  }, [cover?.path, enabled]);
}
