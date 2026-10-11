import { audioFor, imageFor } from "./audio";
import { sourceTitle, type Night } from "./sets";

/** One night as scripts/album-server.py reads it from albums.json. Paths are
 *  relative to /var/www/audio; tag keys are ffmpeg's. */
export type Album = {
  name: string;
  cover?: string;
  tags: Record<string, string>;
  tracks: { file: string; tags: Record<string, string> }[];
};

/** Codecs Apple Music imports as they are. Anything else needs an ALAC encode. */
const IMPORTABLE = new Set(["aac", "alac", "mp3"]);

/** The album download for a night, one track per source, and its size. */
export function album(night: Night): { album: Album; bytes: number } {
  const total = night.tracks.reduce((n, t) => n + t.sources.length, 0);
  let bytes = 0;
  let n = 0;

  const tracks = night.tracks.flatMap((track) =>
    track.sources.map((source, i) => {
      const info = audioFor(source.file);
      let file = source.file;
      if (info.alac) {
        file = info.alac.url.replace(/^\/audio\//, "");
        bytes += info.alac.bytes;
      } else if (IMPORTABLE.has(info.codec)) {
        bytes += info.bytes;
      } else {
        throw new Error(
          `"${source.file}" (${info.codec}) has no ALAC encode for the album download. ` +
            `\`bun run deploy\` makes one; if it already has, delete .audio-manifest.json to re-probe.`,
        );
      }

      const artist = track.artist ?? track.name;
      const tags: Record<string, string> = {
        title: sourceTitle(artist, source.label, i, track.sources.length),
        artist,
        track: `${++n}/${total}`,
      };
      if (track.setlist) tags.lyrics = track.setlist.join("\n");
      return { file, tags };
    }),
  );

  const tags: Record<string, string> = {
    album: night.title,
    album_artist: night.series,
    compilation: "1",
  };
  if (night.recorded) tags.date = String(night.recorded.getUTCFullYear());

  return {
    album: {
      name: night.title,
      ...(night.cover && { cover: imageFor(night.cover) }),
      tags,
      tracks,
    },
    bytes,
  };
}
