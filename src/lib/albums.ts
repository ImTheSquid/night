import { audioFor, imageFor } from "./audio";
import { sourceTitle, type Night } from "./sets";

/** One night as scripts/album-server.py reads it from albums.json. Paths are
 *  relative to /var/www/audio; tag keys are ffmpeg's. `lossless` tracks are
 *  encoded per download variant; the rest are copied as they are. */
export type Album = {
  name: string;
  cover?: string;
  tags: Record<string, string>;
  tracks: { file: string; lossless: boolean; tags: Record<string, string> }[];
};

/** Codecs Apple Music imports as they are. */
const IMPORTABLE = new Set(["aac", "alac", "mp3"]);
/** ALAC over FLAC, measured across the library: 0.96-1.06, median 1.016. */
const ALAC_PER_FLAC = 1.02;
/** The compressed variant's AAC bitrate, as album-server.py encodes it. */
const AAC_BYTES_PER_SECOND = 256_000 / 8;

const isLossless = (codec: string) => codec === "flac" || codec.startsWith("pcm_");

/** The album download for a night, one track per source, and the estimated
 *  size of each variant. */
export function album(night: Night): {
  album: Album;
  bytes: { lossless: number; compressed: number };
} {
  const total = night.tracks.reduce((n, t) => n + t.sources.length, 0);
  const bytes = { lossless: 0, compressed: 0 };
  let n = 0;

  const tracks = night.tracks.flatMap((track) =>
    track.sources.map((source, i) => {
      const info = audioFor(source.file);
      const lossless = isLossless(info.codec);
      if (lossless) {
        bytes.lossless += info.bytes * ALAC_PER_FLAC;
        bytes.compressed += info.duration * AAC_BYTES_PER_SECOND;
      } else if (IMPORTABLE.has(info.codec)) {
        bytes.lossless += info.bytes;
        bytes.compressed += info.bytes;
      } else {
        throw new Error(
          `"${source.file}" (${info.codec}) is neither lossless nor a codec Apple Music imports, ` +
            `so it can't go in the album download.`,
        );
      }

      const artist = track.artist ?? track.name;
      const tags: Record<string, string> = {
        title: sourceTitle(artist, source.label, i, track.sources.length),
        artist,
        track: `${++n}/${total}`,
      };
      if (track.setlist) tags.lyrics = track.setlist.join("\n");
      return { file: source.file, lossless, tags };
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
