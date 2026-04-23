// Location sheet. Shaped for player-facing use (where is this, who's
// here, how does it nest).

import { z } from 'zod';

export const LOCATION_TYPES = [
  'plane',
  'continent',
  'region',
  'city',
  'town',
  'village',
  'dungeon',
  'wilderness',
  'landmark',
  'building',
  'room',
  'other',
] as const;
export const LocationType = z.enum(LOCATION_TYPES);
export type LocationType = z.infer<typeof LocationType>;

export const LocationSheet = z
  .object({
    name: z.string().min(1).optional(),
    type: LocationType.default('other'),
    /** Parent location note path — enables tree view. */
    parent_path: z.string().optional(),
    region: z.string().optional(),
    portrait: z.string().optional(),
    tags: z.array(z.string()).default([]),
    terrain: z.array(z.string()).default([]),
    population: z.string().optional(),
    government: z.string().optional(),
    notable_residents: z
      .array(
        z.object({
          to_path: z.string().min(1),
          role: z.string().optional(),
        }),
      )
      .default([]),
  })
  .passthrough();

export type LocationSheet = z.infer<typeof LocationSheet>;
