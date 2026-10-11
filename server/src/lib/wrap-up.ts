// Wrap-up: folding a Session log into the World as a reviewed proposal.
//
// The app never writes the proposal itself. A Player's own Claude reads
// the Session log and the candidate Notes (`wrapUpContext`), then
// submits a proposal of Mentions (`submitWrapUp`). The app stores it as
// the Session's pending proposal; the closer reviews it and applies it
// (`applyWrapUp`). Applying adds a dated History entry to each
// mentioned Note (creating new Notes where needed), links the log to
// each Note, holds the Suggestions for each Character's Player
// (lib/character-suggestions.ts), then closes the Session. See
// docs/adr/0001-wrap-up-on-close.md.
//
// Everything a client sends is parsed at the boundary into
// `SubmittedMention`, whose `match` union is the only place an
// existing/new decision lives. Apply is idempotent per (Note, Session):
// `addHistoryEntry` and `linkMention` both report `unchanged` when
// their work is already done.

import { z } from 'zod';
import { parseKind } from '@compendium/shared';
import { getDb } from '@/lib/db';
import { loadNote, visibilityFor, type NoteRow } from '@/lib/notes';
import { getCampaignBySlug } from '@/lib/characters';
import { canonicalPath, nameToSlug } from '@/lib/ai/paths';
import { getTemplate, type TemplateKind } from '@/lib/templates';
import { writeNote } from '@/lib/import-apply';
import { deriveFolderIndex, parentFolderUnderCampaign } from '@/lib/campaign-index';
import {
  closeSession,
  getSessionStatus,
  readPendingWrapUpJson,
  resolveCampaignSlug,
  writePendingWrapUpJson,
  type SessionStatus,
} from '@/lib/sessions';
import {
  storeSuggestions,
  type StoredSuggestions,
} from '@/lib/character-suggestions';
import {
  addHistoryEntry,
  applyNoteEdit,
  hasHistoryEntry,
  linkMention,
  type EditResult,
  type PmDoc,
} from '@/lib/note-edits';

// ── Data shape ─────────────────────────────────────────────────────────

export const MENTION_KINDS = ['person', 'creature', 'location', 'item', 'quest', 'lore'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const MAX_MENTIONS = 60;

/** Prose from a client: whitespace collapsed so a History entry stays
 *  one line, then bounded. */
const oneLine = (max: number): z.ZodType<string> =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(max));

const MentionMatch = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('existing'),
      path: z.string().min(1).max(512),
      /** False asks the reviewer "matched to X?" before applying. */
      certain: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('new'),
      title: oneLine(200).refine((t) => nameToSlug(t) !== '', 'title needs letters or digits'),
      summary: z.string().trim().max(2000),
    })
    .strict(),
]);

/** One thing the Session log mentions, as a client proposes it. */
export const SubmittedMention = z
  .object({
    /** As written in the log, e.g. "the innkeeper". */
    name: oneLine(200),
    kind: z.enum(MENTION_KINDS),
    match: MentionMatch,
    /** One or two past-tense sentences for this Session. */
    historyEntry: oneLine(600),
  })
  .strict();
export type SubmittedMention = z.infer<typeof SubmittedMention>;

export const MAX_SUGGESTIONS = 30;

const SuggestedItem = z
  .object({
    name: oneLine(120),
    quantity: z.number().int().min(1).max(999),
  })
  .strict();

const SuggestionShape = z
  .object({
    /** The Character Note the Suggestion is for. */
    characterPath: z.string().min(1).max(512),
    /** Becomes a History entry on the Character. */
    story: oneLine(600).nullable().default(null),
    /** Added to the Character's inventory. Never stats. */
    items: z.array(SuggestedItem).max(20).default([]),
  })
  .strict();

/** What a Character's Player is offered after a Wrap-up, as a client
 *  proposes it. It has to carry something to accept. */
export const SubmittedSuggestion = SuggestionShape.refine(
  (s) => s.story !== null || s.items.length > 0,
  'a Suggestion needs a story or at least one item',
);
export type SubmittedSuggestion = z.infer<typeof SubmittedSuggestion>;

export const WrapUpSubmission = z
  .object({
    sessionPath: z.string().min(1).max(512),
    mentions: z.array(SubmittedMention).max(MAX_MENTIONS),
    suggestions: z
      .array(SubmittedSuggestion)
      .max(MAX_SUGGESTIONS)
      .default([])
      .refine(
        (all) => new Set(all.map((s) => s.characterPath)).size === all.length,
        'one Suggestion per Character',
      ),
  })
  .strict();
export type WrapUpSubmission = z.infer<typeof WrapUpSubmission>;

/** A submitted Mention once stored: the id is assigned by the app and
 *  is stable for the life of the proposal. */
export const Mention = SubmittedMention.extend({ id: z.string().min(1) });
export type Mention = z.infer<typeof Mention>;

/** A submitted Suggestion once stored, with an app-assigned id. */
export const Suggestion = SuggestionShape.extend({ id: z.string().min(1) });
export type Suggestion = z.infer<typeof Suggestion>;

export const WrapUpProposal = z.object({
  sessionPath: z.string().min(1),
  generatedAt: z.number(),
  mentions: z.array(Mention),
  /** Absent in proposals stored before Suggestions existed. */
  suggestions: z.array(Suggestion).default([]),
});
export type WrapUpProposal = z.infer<typeof WrapUpProposal>;

export type Role = 'admin' | 'editor' | 'viewer';

// ── Reading the Session and its candidate Notes ────────────────────────

export type Candidate = {
  path: string;
  title: string;
  kind: MentionKind;
  /** The Note's History already links this Session. */
  recorded: boolean;
};

export type WrapUpContext = {
  session: { path: string; title: string; status: SessionStatus };
  log: string;
  candidates: Candidate[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: number | null;
};

export const DEFAULT_CANDIDATE_LIMIT = 50;
export const MAX_CANDIDATE_LIMIT = 200;

type SessionLookup =
  | { status: 'ok'; note: NoteRow }
  | { status: 'not_found' }
  | { status: 'not_a_session' };

/** The Session note at `path` as `role` may see it. Hidden reads as
 *  missing, so a Player learns nothing from the status code. */
export function loadVisibleSession(groupId: string, role: Role, path: string): SessionLookup {
  const note = loadNote(groupId, path);
  if (!note || isHidden(note, visibilityFor(role))) return { status: 'not_found' };
  return frontmatterKind(note.frontmatter_json) === 'session'
    ? { status: 'ok', note }
    : { status: 'not_a_session' };
}

/** What a client needs to propose well: the log, plus a page of the
 *  Notes `role` may see that a Mention could land on, each marked with
 *  whether it already records this Session. */
export function wrapUpContext(opts: {
  groupId: string;
  role: Role;
  session: NoteRow;
  limit: number;
  cursor: number;
}): WrapUpContext {
  const { groupId, session } = opts;
  const all = visibleCandidates(groupId, opts.role);
  const recorded = recordedPaths(groupId, session.path);
  const page = all.slice(opts.cursor, opts.cursor + opts.limit);
  const end = opts.cursor + page.length;
  return {
    session: {
      path: session.path,
      title: session.title,
      status: getSessionStatus(groupId, session.path),
    },
    log: session.content_text,
    candidates: page.map((c) => ({ ...c, recorded: recorded.has(c.path) })),
    nextCursor: end < all.length ? end : null,
  };
}

/** Notes of a mention kind that `role` may see, by title. */
function visibleCandidates(groupId: string, role: Role): Array<Omit<Candidate, 'recorded'>> {
  const vis = visibilityFor(role);
  const rows = getDb()
    .query<{ path: string; title: string; frontmatter_json: string }, [string]>(
      `SELECT path, title, frontmatter_json FROM notes
        WHERE group_id = ?
          ${vis.hideDmOnly ? 'AND dm_only = 0' : ''}
          ${vis.hideGmOnly ? 'AND gm_only = 0' : ''}
        ORDER BY lower(title), path`,
    )
    .all(groupId);
  const out: Array<Omit<Candidate, 'recorded'>> = [];
  for (const row of rows) {
    const kind = mentionKindOf(row.path, row.frontmatter_json);
    if (kind) out.push({ path: row.path, title: row.title, kind });
  }
  return out;
}

/** Paths of the Notes whose History links `sessionPath`. `note_links`
 *  narrows the search; the body decides. */
function recordedPaths(groupId: string, sessionPath: string): Set<string> {
  const rows = getDb()
    .query<{ path: string; content_json: string }, [string, string]>(
      `SELECT n.path, n.content_json
         FROM note_links l JOIN notes n ON n.group_id = l.group_id AND n.path = l.from_path
        WHERE l.group_id = ? AND l.to_path = ?`,
    )
    .all(groupId, sessionPath);
  const out = new Set<string>();
  for (const row of rows) {
    try {
      if (hasHistoryEntry(JSON.parse(row.content_json) as PmDoc, sessionPath)) out.add(row.path);
    } catch {
      /* unreadable body records nothing */
    }
  }
  return out;
}

/** The Mention kind a Note can receive, or null for Characters,
 *  Sessions and plain Notes. Lore also covers unkinded Notes under
 *  `World Lore/`. */
function mentionKindOf(path: string, frontmatterJson: string): MentionKind | null {
  const parsed = parseKind(frontmatterKind(frontmatterJson));
  if (parsed && (MENTION_KINDS as readonly string[]).includes(parsed)) return parsed as MentionKind;
  if (!parsed && path.startsWith('World Lore/')) return 'lore';
  return null;
}

// ── Submitting a proposal ──────────────────────────────────────────────

export type SubmitResult =
  | { status: 'ok'; proposal: WrapUpProposal }
  | { status: 'not_found' }
  | { status: 'not_a_session' }
  /** A mention matches a visible Note that cannot receive History
   *  (a Character, a Session, a plain Note). */
  | { status: 'invalid_target'; mention: string }
  /** A Suggestion names a visible Note that is not a Character. */
  | { status: 'invalid_suggestion_target'; characterPath: string };

/** Stores `mentions` as the Session's pending proposal, replacing any
 *  earlier one. An `existing` match must name a Note `role` may see;
 *  one that is missing or hidden reads as `not_found`. */
export function submitWrapUp(opts: {
  groupId: string;
  role: Role;
  submission: Omit<WrapUpSubmission, 'suggestions'> & { suggestions?: SubmittedSuggestion[] };
}): SubmitResult {
  const { groupId, role, submission } = opts;
  const suggestions = submission.suggestions ?? [];
  const lookup = loadVisibleSession(groupId, role, submission.sessionPath);
  if (lookup.status !== 'ok') return lookup;

  const vis = visibilityFor(role);
  for (const mention of submission.mentions) {
    if (mention.match.type !== 'existing') continue;
    const target = loadNote(groupId, mention.match.path);
    if (!target || isHidden(target, vis)) return { status: 'not_found' };
    if (!mentionKindOf(target.path, target.frontmatter_json)) {
      return { status: 'invalid_target', mention: mention.name };
    }
  }

  for (const suggestion of suggestions) {
    const target = loadNote(groupId, suggestion.characterPath);
    if (!target || isHidden(target, vis)) return { status: 'not_found' };
    if (parseKind(frontmatterKind(target.frontmatter_json)) !== 'character') {
      return { status: 'invalid_suggestion_target', characterPath: suggestion.characterPath };
    }
  }

  const proposal: WrapUpProposal = {
    sessionPath: submission.sessionPath,
    generatedAt: Date.now(),
    mentions: submission.mentions.map((m, i) => ({ ...m, id: `m${i + 1}` })),
    suggestions: suggestions.map((s, i) => ({ ...s, id: `s${i + 1}` })),
  };
  writePendingWrapUpJson(groupId, submission.sessionPath, JSON.stringify(proposal));
  return { status: 'ok', proposal };
}

/** The stored proposal, with any existing-Note mentions `role` may not
 *  see removed, so a GM's proposal never reveals a hidden Note to a
 *  Player who resumes it. */
export function loadPendingWrapUp(
  groupId: string,
  role: Role,
  sessionPath: string,
): WrapUpProposal | null {
  const json = readPendingWrapUpJson(groupId, sessionPath);
  if (!json) return null;
  let proposal: WrapUpProposal;
  try {
    proposal = WrapUpProposal.parse(JSON.parse(json));
  } catch {
    return null;
  }
  const vis = visibilityFor(role);
  const visible = (path: string): boolean => {
    const note = loadNote(groupId, path);
    return note !== null && !isHidden(note, vis);
  };
  return {
    ...proposal,
    mentions: proposal.mentions.filter((m) => m.match.type !== 'existing' || visible(m.match.path)),
    suggestions: proposal.suggestions.filter((s) => visible(s.characterPath)),
  };
}

/** Titles of the Notes a proposal points at (existing matches and
 *  Suggestion Characters), for the review dialog's "Matched to <Title>?"
 *  and its Suggestions list. Call it on a proposal from
 *  `loadPendingWrapUp`, which already dropped what the reader cannot see. */
export function existingTitles(groupId: string, proposal: WrapUpProposal): Record<string, string> {
  const paths = [
    ...proposal.mentions.flatMap((m) => (m.match.type === 'existing' ? [m.match.path] : [])),
    ...proposal.suggestions.map((s) => s.characterPath),
  ];
  const out: Record<string, string> = {};
  for (const path of paths) {
    const note = loadNote(groupId, path);
    if (note) out[path] = note.title;
  }
  return out;
}

// ── Apply ──────────────────────────────────────────────────────────────

export type WrapUpDecisions = {
  /** Mention ids the closer ticked. */
  accepted: string[];
  /** Accepted mention ids whose uncertain match the closer switched to a new Note. */
  asNew: string[];
};

export type AppliedMention = { id: string; path: string; created: boolean };

export type ApplyResult = {
  applied: AppliedMention[];
  /** Accepted mentions that could not be applied, and why. */
  skipped: Array<{ id: string; reason: 'unknown_mention' | 'not_visible' }>;
  /** Suggestions held for Characters' Players. */
  suggestions: StoredSuggestions;
};

/** Applies the closer's decisions on `proposal`, links the log, holds
 *  the proposal's Suggestions for their Players, closes the Session and
 *  clears its pending proposal. Running it again with the same proposal
 *  writes nothing new. */
export async function applyWrapUp(opts: {
  groupId: string;
  userId: string;
  role: Role;
  sessionPath: string;
  proposal: WrapUpProposal;
  decisions: WrapUpDecisions;
}): Promise<ApplyResult> {
  const { groupId, userId, role, sessionPath, proposal } = opts;
  const session = loadNote(groupId, sessionPath);
  if (!session) throw new Error(`Session not found: ${sessionPath}`);
  const vis = visibilityFor(role);
  const byId = new Map(proposal.mentions.map((m) => [m.id, m]));
  const asNew = new Set(opts.decisions.asNew);
  const campaign = campaignFor(groupId, session);

  const applied: AppliedMention[] = [];
  const skipped: ApplyResult['skipped'] = [];
  for (const id of new Set(opts.decisions.accepted)) {
    const mention = byId.get(id);
    if (!mention) {
      skipped.push({ id, reason: 'unknown_mention' });
      continue;
    }
    const target = await resolveTarget({
      groupId, userId, vis, mention, forceNew: asNew.has(id), campaign, session,
    });
    if (!target) {
      skipped.push({ id, reason: 'not_visible' });
      continue;
    }
    await applyNoteEdit({
      groupId,
      path: target.path,
      userId,
      edit: (doc) =>
        addHistoryEntry(doc, { sessionPath, sessionTitle: session.title, text: mention.historyEntry }),
    });
    applied.push({ id, path: target.path, created: target.created });
  }

  if (applied.length) {
    const links = applied.map((a) => ({ text: byId.get(a.id)!.name, targetPath: a.path }));
    await applyNoteEdit({
      groupId,
      path: sessionPath,
      userId,
      edit: (doc) => linkAll(doc, links),
    });
  }

  const suggestions = storeSuggestions({
    groupId,
    sessionPath,
    suggestions: proposal.suggestions,
    isVisible: (path) => {
      const note = loadNote(groupId, path);
      return note !== null && !isHidden(note, vis);
    },
  });

  closeSession(groupId, sessionPath, userId);
  return { applied, skipped, suggestions };
}

function linkAll(doc: PmDoc, links: Array<{ text: string; targetPath: string }>): EditResult {
  let current = doc;
  let changed = false;
  for (const link of links) {
    const result = linkMention(current, link);
    if (result.status === 'changed') {
      current = result.doc;
      changed = true;
    }
  }
  return changed ? { status: 'changed', doc: current } : { status: 'unchanged' };
}

type Campaign = { slug: string; folderPath: string } | null;

function campaignFor(groupId: string, session: NoteRow): Campaign {
  let fm: Record<string, unknown> = {};
  try {
    fm = JSON.parse(session.frontmatter_json) as Record<string, unknown>;
  } catch {
    /* no campaign */
  }
  const slug = resolveCampaignSlug(fm, session.path);
  if (!slug) return null;
  const row = getCampaignBySlug(groupId, slug);
  return row ? { slug: row.slug, folderPath: row.folderPath } : null;
}

type Visibility = ReturnType<typeof visibilityFor>;

/** The Note a mention lands on, creating it when it is new and nothing
 *  with that title or canonical path exists yet. Null when the
 *  existing target is hidden from the closer. A created Note is as
 *  hidden as the Session it came from. */
async function resolveTarget(opts: {
  groupId: string;
  userId: string;
  vis: Visibility;
  mention: Mention;
  forceNew: boolean;
  campaign: Campaign;
  session: NoteRow;
}): Promise<{ path: string; created: boolean } | null> {
  const { groupId, userId, vis, mention, session } = opts;
  const match = mention.match;

  if (match.type === 'existing' && !opts.forceNew) {
    const note = loadNote(groupId, match.path);
    return note && !isHidden(note, vis) ? { path: match.path, created: false } : null;
  }

  const title = match.type === 'new' ? match.title : mention.name;
  const summary = match.type === 'new' ? match.summary : '';
  const path = canonicalPath({
    kind: mention.kind,
    campaignSlug: opts.campaign?.slug,
    campaignRoot: opts.campaign?.folderPath,
    name: title,
  });

  const existing = loadNote(groupId, path) ?? findVisibleByTitle(groupId, vis, title, mention.kind);
  if (existing) {
    return isHidden(existing, vis) ? null : { path: existing.path, created: false };
  }

  const frontmatter = newNoteFrontmatter(mention.kind, title);
  // Every derive recomputes the dm_only column from this flag, so the
  // flag has to be in the frontmatter or the next save un-hides the Note.
  if (session.dm_only === 1) frontmatter.dm_only = true;
  writeNote({ groupId, userId, path, markdown: summary, frontmatter, isUpdate: false });
  if (session.dm_only === 1 || session.gm_only === 1) {
    getDb()
      .query('UPDATE notes SET dm_only = ?, gm_only = ? WHERE group_id = ? AND path = ?')
      .run(session.dm_only, session.gm_only, groupId, path);
  }
  const parent = parentFolderUnderCampaign(path);
  if (parent) {
    await deriveFolderIndex(groupId, parent, { userId }).catch((err) => {
      console.error('[wrap-up] folder index refresh failed:', err);
    });
  }
  return { path, created: true };
}

/** Seed frontmatter for a new Note: its kind and, for kinds with a
 *  template, a Sheet holding the template defaults. */
function newNoteFrontmatter(kind: MentionKind, title: string): Record<string, unknown> {
  if (kind === 'quest' || kind === 'lore') return { kind };
  const template = getTemplate(kind as TemplateKind);
  const sheet: Record<string, unknown> = { name: title };
  for (const section of template?.schema.sections ?? []) {
    for (const field of section.fields) {
      if (field.id !== 'name' && field.default !== undefined) sheet[field.id] = field.default;
    }
  }
  return { kind, template: kind, sheet };
}

function findVisibleByTitle(
  groupId: string,
  vis: Visibility,
  title: string,
  kind: MentionKind,
): NoteRow | null {
  const rows = getDb()
    .query<{ path: string }, [string, string]>(
      'SELECT path FROM notes WHERE group_id = ? AND lower(title) = lower(?)',
    )
    .all(groupId, title.trim());
  for (const row of rows) {
    const note = loadNote(groupId, row.path);
    if (!note || isHidden(note, vis)) continue;
    if (mentionKindOf(note.path, note.frontmatter_json) === kind) return note;
  }
  return null;
}

// ── Shared ─────────────────────────────────────────────────────────────

function frontmatterKind(frontmatterJson: string): unknown {
  try {
    return (JSON.parse(frontmatterJson) as { kind?: unknown }).kind;
  } catch {
    return undefined;
  }
}

function isHidden(note: { dm_only: number; gm_only: number }, vis: Visibility): boolean {
  return (note.gm_only === 1 && vis.hideGmOnly) || (note.dm_only === 1 && vis.hideDmOnly);
}
