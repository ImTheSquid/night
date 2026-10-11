import type { APIRoute } from "astro";
import { album, type Album } from "../lib/albums";
import { greenLight, jackNights, nightIds } from "../lib/sets";

/** Every album download, keyed by night id, for scripts/album-server.py. */
export const GET: APIRoute = async () => {
  // Each series and the page it's on, so the "preparing" page can link back.
  const pages = [
    { page: "/", sets: await jackNights() },
    { page: "/green-light", sets: await greenLight() },
  ];
  const albums: Record<string, Album & { back: string }> = {};
  for (const { page, sets } of pages) {
    const ids = nightIds(sets);
    sets.forEach((night, i) => {
      // Ids are only unique per page; the album URL needs them site-wide.
      if (albums[ids[i]]) {
        throw new Error(`two nights would share the album URL /albums/${ids[i]}.zip`);
      }
      albums[ids[i]] = { ...album(night).album, back: `${page}#${ids[i]}` };
    });
  }
  return new Response(JSON.stringify(albums, null, 2) + "\n");
};
