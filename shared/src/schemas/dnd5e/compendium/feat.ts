import { z } from 'zod';
import { Modifier } from '../primitives';

export const FeatDef = z.object({
  name: z.string().min(1),
  prerequisite: z.string().optional(),
  description: z.string().default(''),
  /** Structured effects that automatically apply to a character with this
   *  feat. Items use the same Modifier shape so the compute layer can
   *  treat feats and gear uniformly. */
  modifiers: z.array(Modifier).default([]),
});
export type FeatDef = z.infer<typeof FeatDef>;
