import { z } from 'zod';

export const BackgroundDef = z.object({
  name: z.string().min(1),
  skill_proficiencies: z.array(z.string()).default([]),
  tool_proficiencies: z.array(z.string()).default([]),
  languages: z.object({
    choose: z.number().int().min(0).default(0),
    fixed: z.array(z.string()).default([]),
  }),
  equipment: z.array(z.string()).default([]),
  feature: z.object({
    name: z.string().min(1),
    description: z.string().default(''),
  }),
  suggested_characteristics: z.string().optional(),
});
export type BackgroundDef = z.infer<typeof BackgroundDef>;
