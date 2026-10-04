import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/** One playable file. Only `file` and `label` are authored -- duration, size
 *  and channel count come from the server manifest via src/lib/audio.ts. */
const source = z.object({
  /** Path under /audio, e.g. "jn4/Xendergo.flac". Must exist in the manifest. */
  file: z.string(),
  /** Shown above the player when a track has several distinct versions. */
  label: z.string().optional(),
});

const track = z.object({
  /** Display name, and the Media Session title. */
  name: z.string(),
  /** Media Session artist. Defaults to name. */
  artist: z.string().optional(),
  sources: z.array(source).min(1),
  setlist: z.array(z.string()).optional(),
});

/** Fields every night shares, whatever the series orders itself by. */
const night = {
  /** Heading, and the Media Session album. */
  title: z.string(),
  /** Italic subheading under the title. */
  note: z.string().optional(),
  /** Render as <ol> rather than <ul>. */
  numbered: z.boolean().default(false),
  tracks: z.array(track).min(1),
};

/** Files starting with _ are ignored, so drafts and templates can sit alongside.
 *  A negated pattern rather than `[!_]*`, which the dev watcher's matcher
 *  inverts. */
const yaml = (base: string) => glob({ pattern: ["**/*.yaml", "!**/_*"], base });

/** The numbered Jack Nights. Sequence is authored, since it is not the dates
 *  people refer to them by. */
const jackNight = defineCollection({
  loader: yaml("./src/data/jack-night"),
  schema: z.object({ order: z.number(), ...night }),
});

/** A recurring night, so the date is the only ordering it needs -- and the only
 *  heading it needs, unless a particular one is worth naming. */
const greenLight = defineCollection({
  loader: yaml("./src/data/green-light"),
  schema: z.object({ ...night, date: z.coerce.date(), title: z.string().optional() }),
});

export const collections = { jackNight, greenLight };
