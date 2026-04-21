// Lightweight NPC from the player's POV. The prose body (TipTap) is
// attached to every note, so `notes`, `description` etc. live there,
// not in this sheet.

import { z } from 'zod';

export const PersonSheet = z
  .object({
    name: z.string().min(1).optional(),
    tagline: z.string().optional(),
    /** Wikilink-style path to a Location note, e.g. 'Places/Waterdeep'. */
    location_path: z.string().optional(),
    portrait: z.string().optional(),
    tags: z.array(z.string()).default([]),
    disposition: z
      .enum(['friendly', 'neutral', 'hostile', 'unknown'])
      .default('unknown'),
    relationships: z
      .array(
        z.object({
          to_path: z.string().min(1),
          label: z.string().min(1),
        }),
      )
      .default([]),
  })
  .passthrough();

export type PersonSheet = z.infer<typeof PersonSheet>;
