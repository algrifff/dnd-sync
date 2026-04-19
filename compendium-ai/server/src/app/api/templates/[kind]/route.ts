// GET  /api/templates/:kind   — read one template (any authed user)
// PUT  /api/templates/:kind   — upsert (admin only)

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { verifyCsrf } from '@/lib/csrf';
import {
  getTemplate,
  upsertTemplate,
  TEMPLATE_KINDS,
  type TemplateKind,
} from '@/lib/templates';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ kind: string }> };

const FieldSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/i, 'id must be lowercase slug'),
  label: z.string().min(1),
  type: z.enum([
    'text',
    'longtext',
    'integer',
    'number',
    'enum',
    'boolean',
    'list<text>',
  ]),
  required: z.boolean().optional(),
  default: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
  hint: z.string().optional(),
  playerEditable: z.boolean().optional(),
});

const SectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/i),
  label: z.string().min(1),
  fields: z.array(FieldSchema),
});

const Body = z.object({
  name: z.string().min(1).max(120),
  schema: z.object({
    version: z.number().int().min(1),
    sections: z.array(SectionSchema),
  }),
});

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireSession(_req);
  if (session instanceof Response) return session;

  const { kind } = await ctx.params;
  if (!isKind(kind)) return json({ error: 'unknown_kind' }, 404);

  const tpl = getTemplate(kind);
  if (!tpl) return json({ error: 'not_found' }, 404);
  return json({ template: tpl });
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  const csrf = verifyCsrf(req, session);
  if (csrf) return csrf;

  const { kind } = await ctx.params;
  if (!isKind(kind)) return json({ error: 'unknown_kind' }, 404);

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'bad' },
      400,
    );
  }

  // Sanity: field ids must be unique within the whole schema (across
  // sections) because they collide in the flat frontmatter `sheet:`
  // map.
  const seen = new Set<string>();
  for (const section of parsed.schema.sections) {
    for (const field of section.fields) {
      if (seen.has(field.id)) {
        return json(
          { error: 'duplicate_field_id', detail: field.id },
          400,
        );
      }
      seen.add(field.id);
    }
  }

  upsertTemplate(kind, parsed.name, parsed.schema, session.userId);
  return json({ ok: true });
}

function isKind(kind: string): kind is TemplateKind {
  return (TEMPLATE_KINDS as readonly string[]).includes(kind);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
