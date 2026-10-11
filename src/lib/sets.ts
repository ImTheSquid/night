import { getCollection } from "astro:content";
import { orphans } from "./audio";

/** What <Set> renders. Each series maps its own entries onto this. */
export type Night = {
  title: string;
  /** Plain subheading, for when the title isn't already the date. */
  date?: string;
  /** The night's calendar day, where known. The album's year. */
  recorded?: Date;
  /** The series name, and the album artist. */
  series: string;
  note?: string;
  numbered: boolean;
  /** Album artwork, a path under /audio. */
  cover?: string;
  tracks: {
    name: string;
    artist?: string;
    sources: { file: string; label?: string }[];
    setlist?: string[];
  }[];
};

/** "13 June 2025" */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC", // dates are calendar days, not instants
  });
}

/** "Jack Night 4: Continental" -> "jack-night-4-continental". Accents are
 *  folded rather than dropped, so "Sebastián" stays "sebastian". */
export function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slugs for a list of headings, suffixed only where two would collide.
 *  `fallback` names anything that slugifies to nothing, e.g. a title of emoji. */
export function uniqueSlugs(titles: string[], fallback = "item"): string[] {
  const seen = new Map<string, number>();
  return titles.map((title, i) => {
    const base = slug(title) || `${fallback}-${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  });
}

/** Anchor ids for a page of nights. Also the album download's name, so the
 *  page and albums.json must both get them from here. */
export function nightIds(sets: Night[]): string[] {
  return uniqueSlugs(sets.map((set) => set.title));
}

/** Tells apart the sources of one track: by label, else by part number. */
export function sourceTitle(
  artist: string,
  label: string | undefined,
  index: number,
  total: number,
): string {
  if (label) return `${artist} — ${label}`;
  return total > 1 ? `${artist} (Part ${index + 1})` : artist;
}

/** The numbered Jack Nights, oldest first. */
export async function jackNights(): Promise<Night[]> {
  const entries = await getCollection("jackNight");
  return entries
    .sort((a, b) => a.data.order - b.data.order)
    .map((e) => ({ ...e.data, series: "Jack Night" }));
}

/** Green Light, oldest first. Untitled ones are headed by their date; titled
 *  ones carry it as a subheading. */
export async function greenLight(): Promise<Night[]> {
  const entries = await getCollection("greenLight");
  return entries
    .sort((a, b) => a.data.date.getTime() - b.data.date.getTime())
    .map(({ data: { date, title, ...night } }) => {
      const common = { ...night, recorded: date, series: "Green Light" };
      return title
        ? { ...common, title, date: formatDate(date) }
        : { ...common, title: `Green Light ${formatDate(date)}` };
    });
}

let checked = false;

/**
 * Warn about audio on the server that no night lists. Runs once across all
 * series, so a file listed on another page is not reported as unlisted.
 */
export async function warnUnlisted(): Promise<void> {
  if (checked) return;
  checked = true;

  const referenced = new Set<string>();
  for (const night of [...(await jackNights()), ...(await greenLight())]) {
    for (const track of night.tracks) {
      for (const source of track.sources) referenced.add(source.file);
    }
  }

  const unlisted = orphans(referenced);
  if (unlisted.length) {
    console.warn(
      `[audio] ${unlisted.length} file(s) on the server are on no page:\n` +
        unlisted.map((f) => `  ${f}`).join("\n"),
    );
  }
}
