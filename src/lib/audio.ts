import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved against cwd, not import.meta.url: this module gets bundled into
// dist/ during the build, where a relative URL would point at the wrong tree.
const ROOT = process.cwd();
const CACHE = resolve(ROOT, ".audio-manifest.json");
const SYNC = resolve(ROOT, "scripts/audio-sync.py");
const HOST = process.env.JACK_NIGHT_HOST ?? "server";

/** A transcoded copy. Absent until audio-sync has produced it. */
export type Encoded = { url: string; bytes: number };

export type AudioInfo = {
  /** Seconds. */
  duration: number;
  /** Size of the original file. */
  bytes: number;
  channels: number;
  codec: string;
  /** URL of the original, e.g. "/audio/jn4/Xendergo.flac". */
  src: string;
  /** Opus in Ogg. Smallest, but Safari support varies by version. */
  opus?: Encoded;
  /** AAC in MP4. The fallback that plays everywhere. */
  aac?: Encoded;
};

type Manifest = { generated: string; tracks: Record<string, AudioInfo> };

/**
 * The audio lives on the server, not here, so metadata is probed there and
 * cached locally. The cache is derived and gitignored; a missing one is
 * refetched rather than being an error, so a fresh clone just builds.
 */
function load(): Manifest {
  if (!existsSync(CACHE)) {
    console.log(`[audio] no manifest, probing ${HOST}...`);
    const script = readFileSync(SYNC);
    let json: string;
    try {
      json = execFileSync(
        "ssh",
        [HOST, "python3", "-", "--probe-only", "--manifest", "-"],
        // stderr inherited so ssh/python failures are visible, not swallowed.
        { input: script, encoding: "utf8", maxBuffer: 32 << 20, stdio: ["pipe", "pipe", "inherit"] },
      );
    } catch (cause) {
      throw new Error(
        `Could not reach ${HOST} to probe the audio library.\n` +
          `Fix your ssh access, or set JACK_NIGHT_HOST to another host.`,
        { cause },
      );
    }
    writeFileSync(CACHE, json);
  }
  return JSON.parse(readFileSync(CACHE, "utf8")) as Manifest;
}

const manifest = load();

/** Metadata for an authored `file:` path. Unknown paths fail the build. */
export function audioFor(file: string): AudioInfo {
  const info = manifest.tracks[file];
  if (!info) {
    throw new Error(
      `"${file}" is not in the audio manifest.\n` +
        `Either the path is wrong, or it is new on the server -- ` +
        `delete .audio-manifest.json to re-probe.`,
    );
  }
  return info;
}

/** Files present on the server that no set references. */
export function orphans(referenced: Set<string>): string[] {
  return Object.keys(manifest.tracks).filter((f) => !referenced.has(f));
}

/**
 * "1:02:45" / "24:17". Taken from the manifest rather than the player, which
 * cannot be relied on: a page with 31 <audio> elements hits a browser limit on
 * concurrent media loads and most of them never report a duration at all.
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "1.02 GB" */
export function formatBytes(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : `${Math.round(bytes / 1e6)} MB`;
}
