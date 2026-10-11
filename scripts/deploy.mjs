#!/usr/bin/env node
/**
 * The one command. Order is fixed here so it can't be got wrong:
 *
 *   1. transcode anything new on the server, and re-probe the library
 *   2. build against the fresh manifest
 *   3. rsync dist/ to the web root
 *   4. install and restart the album server
 *
 * Step 1 is idempotent -- it skips files that already have both encodes, so
 * re-running costs a few seconds when nothing has changed.
 *
 * --dry-run stops the rsyncs from writing and skips the restart. Steps 1 and 2
 * still run; both are safe to repeat.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const MANIFEST = fileURLToPath(new URL(".audio-manifest.json", ROOT));
const SYNC = fileURLToPath(new URL("scripts/audio-sync.py", ROOT));
const ALBUM_SERVER = fileURLToPath(new URL("scripts/album-server.py", ROOT));
const ALBUM_UNIT = fileURLToPath(new URL("scripts/jack-night-albums.service", ROOT));

const HOST = process.env.JACK_NIGHT_HOST ?? "server";
const WEB_ROOT = process.env.JACK_NIGHT_WEB_ROOT ?? "/var/www/html/djhost";

const dryRun = process.argv.includes("--dry-run");

function step(n, message) {
  console.log(`\n[${n}/4] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? result.signal}`);
  }
  return result;
}

step(1, `transcoding + probing on ${HOST}`);
// Piped over ssh rather than installed, so the server keeps no copy to go stale.
const manifest = execFileSync("ssh", [HOST, "python3", "-", "--manifest", "-"], {
  input: readFileSync(SYNC),
  encoding: "utf8",
  maxBuffer: 32 << 20,
  stdio: ["pipe", "pipe", "inherit"],
});
writeFileSync(MANIFEST, manifest);

// Without both streaming encodes some browser is left falling back to a 400 MB
// FLAC; without the ALAC, the album download has no importable copy.
const { tracks } = JSON.parse(manifest);
const gaps = (t) =>
  [
    !t.opus && "no opus",
    !t.aac && "no aac",
    !t.alac && (t.codec === "flac" || t.codec.startsWith("pcm_")) && "no alac",
  ].filter(Boolean);
const missing = Object.entries(tracks).filter(([, t]) => gaps(t).length);
if (missing.length) {
  throw new Error(
    `${missing.length} file(s) are missing an encode:\n` +
      missing.map(([f, t]) => `  ${f} (${gaps(t).join(", ")})`).join("\n"),
  );
}

step(2, "building");
run("bun", ["run", "build"], { cwd: fileURLToPath(ROOT) });

step(3, `rsyncing to ${HOST}:${WEB_ROOT}`);
// Not -a: the web root is www-data's, so preserving perms/owner/dir-times just
// earns a permission error. File mtimes are kept for rsync's own change checks.
run("rsync", [
  "-rltv",
  "--omit-dir-times",
  "--no-perms",
  "--delete",
  ...(dryRun ? ["--dry-run"] : []),
  `${fileURLToPath(new URL("dist/", ROOT))}`,
  `${HOST}:${WEB_ROOT}/`,
]);

step(4, `installing album server on ${HOST}`);
// Installed rather than piped like audio-sync, since it has to keep running.
// Shipped on every deploy so the server's copy can't go stale.
run("ssh", [HOST, "mkdir", "-p", ".local/share/jack-night", ".config/systemd/user"]);
run("rsync", [
  "-tv",
  ...(dryRun ? ["--dry-run"] : []),
  ALBUM_SERVER,
  `${HOST}:.local/share/jack-night/`,
]);
run("rsync", [
  "-tv",
  ...(dryRun ? ["--dry-run"] : []),
  ALBUM_UNIT,
  `${HOST}:.config/systemd/user/`,
]);
if (!dryRun) {
  run("ssh", [
    HOST,
    "systemctl --user daemon-reload && " +
      "systemctl --user enable jack-night-albums && " +
      "systemctl --user restart jack-night-albums",
  ]);
}

console.log(dryRun ? "\ndry run, nothing written" : "\nhttps://night.jackhogan.me");
