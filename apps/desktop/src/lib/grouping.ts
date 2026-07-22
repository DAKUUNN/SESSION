/**
 * Filename-based grouping heuristic for drag-and-dropped audio files.
 *
 * Given a flat list of file paths, groups files that look like different
 * "versions" of the same underlying track — e.g. `Track master v1.wav` and
 * `Track master v2.wav` both reduce to base title "Track" with version
 * labels "Master v1" / "Master v2". A file whose base title doesn't match
 * anything else becomes its own single-version group.
 *
 * Pure and synchronous — no filesystem or backend access — so it's easy to
 * unit test and to preview in the import review modal before committing.
 */
import type { ImportGroupInput } from "./api";

export type ImportGroup = ImportGroupInput;

// Common version/take indicators we recognize at the end of a filename.
// Keep this list modest — it only needs to cover the vocabulary artists
// actually use, not be exhaustive.
const VERSION_KEYWORDS = [
  "master",
  "mix",
  "demo",
  "final",
  "take",
  "version",
  "edit",
  "alt",
  "rough",
  "draft",
  "sketch",
  "rev",
];

const KEYWORD_ALTERNATION = VERSION_KEYWORDS.join("|");

// Matches a trailing version indicator at the end of a filename (sans
// extension), optionally preceded by a separator (" - ", "_", or plain
// whitespace). Covers "Master", "Master v1", "Mix 2", "Demo", "v3", etc.
const VERSION_SUFFIX_RE = new RegExp(
  `(?:^|[\\s_-]+)((?:${KEYWORD_ALTERNATION})(?:[\\s_.]*v?\\.?\\s*\\d+)?|v\\.?\\s*\\d+)$`,
  "i",
);

function stripExtension(path: string): string {
  const filename = path.split(/[\\/]/).pop() ?? path;
  return filename.replace(/\.[^./\\]+$/, "");
}

function normalizeSeparators(s: string): string {
  return s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function toTitleCase(s: string): string {
  return normalizeSeparators(s)
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

/** Formats a matched version suffix "nicely", e.g. "master v1" -> "Master v1". */
function formatVersionLabel(raw: string): string {
  // Insert a space between a letter and an immediately-adjacent digit (so
  // "mix2" -> "mix 2"), but leave "v1" / "v2" fused since that's the
  // desired fused form ("Master v1", not "Master v 1").
  const spaced = raw.replace(/([a-zA-Z])(\d)/g, (m, letter: string, digit: string) =>
    letter.toLowerCase() === "v" ? m : `${letter} ${digit}`,
  );
  return normalizeSeparators(spaced)
    .split(" ")
    .map((word) => {
      const vMatch = /^v\.?(\d+)$/i.exec(word);
      if (vMatch) return `v${vMatch[1]}`;
      if (/^\d+$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Ranks a matched version suffix for ordering purposes: higher numbers sort
 * later, an un-numbered "master"/"final" outranks any plain numbered take
 * (it reads as "the" definitive version), and everything else falls in
 * between. Files with no version marker at all rank lowest.
 */
function rankSuffix(rawSuffix: string | null): number {
  if (!rawSuffix) return -1;
  const numMatch = /(\d+)/.exec(rawSuffix);
  if (numMatch) return 1000 + parseInt(numMatch[1], 10);
  if (/master|final/i.test(rawSuffix)) return 900;
  return 500;
}

interface ParsedFile {
  path: string;
  baseKey: string;
  baseTitle: string;
  label: string;
  rank: number;
}

function parseFile(path: string): ParsedFile {
  const nameNoExt = stripExtension(path);
  const match = VERSION_SUFFIX_RE.exec(nameNoExt);

  if (!match) {
    const base = nameNoExt.trim();
    return { path, baseKey: base.toLowerCase(), baseTitle: toTitleCase(base), label: "Original", rank: -1 };
  }

  const suffix = match[1];
  const base = nameNoExt.slice(0, match.index).trim();

  if (!base) {
    // The whole filename was consumed by the version pattern (e.g. a file
    // literally named "Master.wav") — fall back to treating the full name
    // as the base rather than producing an empty title.
    const fallback = nameNoExt.trim();
    return {
      path,
      baseKey: fallback.toLowerCase(),
      baseTitle: toTitleCase(fallback),
      label: "Original",
      rank: -1,
    };
  }

  return {
    path,
    baseKey: base.toLowerCase(),
    baseTitle: toTitleCase(base),
    label: formatVersionLabel(suffix),
    rank: rankSuffix(suffix),
  };
}

/**
 * Groups a flat list of file paths by base title. Case-insensitive: "Track
 * Master V1" and "track master v2" both belong to base title "Track".
 * Within a group, versions are sorted ascending by rank (numeric version
 * order, "master"/"final" ranking highest), and `defaultVersionIndex`
 * points at the last (highest-ranked) entry.
 */
export function groupFilesByBaseName(paths: string[]): ImportGroup[] {
  const parsed = paths.map(parseFile);

  const order: string[] = [];
  const byKey = new Map<string, ParsedFile[]>();
  for (const file of parsed) {
    if (!byKey.has(file.baseKey)) {
      order.push(file.baseKey);
      byKey.set(file.baseKey, []);
    }
    byKey.get(file.baseKey)!.push(file);
  }

  return order.map((key) => {
    const files = byKey.get(key)!;
    const sorted = [...files].sort((a, b) => a.rank - b.rank);
    return {
      title: files[0].baseTitle,
      versions: sorted.map((f) => ({ label: f.label, path: f.path })),
      defaultVersionIndex: sorted.length - 1,
    };
  });
}
