import { getCollection } from "astro:content";
import { orphans } from "./audio";

/** What <Set> renders. Each series maps its own entries onto this. */
export type Night = {
  title: string;
  note?: string;
  numbered: boolean;
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

/** The numbered Jack Nights, oldest first. */
export async function jackNights(): Promise<Night[]> {
  const entries = await getCollection("jackNight");
  return entries.sort((a, b) => a.data.order - b.data.order).map((e) => e.data);
}

/** Second Fridays, oldest first. Untitled ones are headed by their date. */
export async function secondFridays(): Promise<Night[]> {
  const entries = await getCollection("secondFridays");
  return entries
    .sort((a, b) => a.data.date.getTime() - b.data.date.getTime())
    .map((e) => ({ ...e.data, title: e.data.title ?? formatDate(e.data.date) }));
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
  for (const night of [...(await jackNights()), ...(await secondFridays())]) {
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
