// Wrap-up: folding a Session log into the World as a reviewed proposal.
//
// The app never writes the proposal itself. A Player's own Claude reads
// the Session log and the candidate Notes (`wrapUpContext`), then
// submits a proposal of Mentions (`submitWrapUp`). The app stores it as
// the Session's pending proposal; the closer reviews it and applies it
// (`applyWrapUp`). Applying adds a dated History entry to each
// mentioned Note (creating new Notes where needed), links the log to
// each Note, records the ticked Relationships (lib/relations.ts, after
// the mentions so created Notes have paths), holds the Suggestions for
// each Character's Player (lib/character-suggestions.ts), then closes the
// Session. See docs/adr/0001-wrap-up-on-close.md and
// docs/adr/0002-typed-relationships.md.
//
// Everything a client sends is parsed at the boundary into
// `SubmittedMention`, whose `match` union is the only place an
// existing/new decision lives. Apply is idempotent per (Note, Session):
// `addHistoryEntry` and `linkMention` both report `unchanged` when
// their work is already done.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseKind, RelationType } from '@compendium/shared';
import { getDb } from '@/lib/db';
import { addRelation } from '@/lib/relations';
import { loadNameIndex, matchName, type NameIndex, type SimilarNote } from '@/lib/similar-names';
import { loadNote, visibilityFor, type NoteRow } from '@/lib/notes';
import { getCampaignBySlug } from '@/lib/characters';
import { canonicalPath } from '@/lib/paths';
import { slugify } from '@/lib/slugify';
import { createNote } from '@/lib/create-note';
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

// Stripping control and invisible characters is the point of this regex:
// C0/C1 controls, zero-width and word-joiner characters, the BOM, and
// the bidi embedding/override/isolate marks.
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Prose from a client: whitespace collapsed so a History entry stays
 *  one line, control and zero-width characters removed, then bounded. */
const oneLine = (max: number): z.ZodType<string> =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').replace(INVISIBLE_CHARS, '').trim())
    .pipe(z.string().min(1).max(max));

const hasLetterOrDigit = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);

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
      title: oneLine(200).refine(hasLetterOrDigit, 'title needs letters or digits'),
      summary: z.string().trim().max(2000),
    })
    .strict(),
]);

/** One thing the Session log mentions, as a client proposes it. */
export const SubmittedMention = z
  .object({
    /** As written in the log, e.g. "the innkeeper". */
    name: oneLine(200).refine(hasLetterOrDigit, 'name needs letters or digits'),
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

export const MAX_RELATIONS = 60;

/** One end of a proposed Relationship: a mention in the same submission
 *  (matched by its `name`, so a Note the Wrap-up is about to create can
 *  take part) or a Note that already exists, of any kind. */
const SubmittedEndpoint = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mention'), name: oneLine(200) }).strict(),
  z.object({ type: z.literal('existing'), path: z.string().min(1).max(512) }).strict(),
]);

/** How two Notes stand to each other, as a client proposes it. The type
 *  comes from the shared list (docs/adr/0002-typed-relationships.md). */
export const SubmittedRelation = z
  .object({
    from: SubmittedEndpoint,
    relation: RelationType,
    to: SubmittedEndpoint,
    /** Why the log says so; shown to the reviewer, never stored on a Note. */
    note: oneLine(300).optional(),
  })
  .strict();
export type SubmittedRelation = z.infer<typeof SubmittedRelation>;

export const WrapUpSubmission = z
  .object({
    sessionPath: z.string().min(1).max(512),
    mentions: z.array(SubmittedMention).max(MAX_MENTIONS),
    relations: z.array(SubmittedRelation).max(MAX_RELATIONS).default([]),
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

/** A submitted Mention once stored: the id is assigned by the app, is
 *  opaque and stable for the life of the proposal. It is deliberately
 *  not a counter: a reader who cannot see some Mentions would otherwise
 *  see gaps in the numbering. */
export const Mention = SubmittedMention.extend({ id: z.string().min(1) });
export type Mention = z.infer<typeof Mention>;

/** A submitted Suggestion once stored, with an app-assigned id. */
export const Suggestion = SuggestionShape.extend({ id: z.string().min(1) });
export type Suggestion = z.infer<typeof Suggestion>;

/** A stored end: a mention names the Mention by its id, resolved at
 *  submit time, so it cannot go ambiguous later. */
const StoredEndpoint = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mention'), mentionId: z.string().min(1) }),
  z.object({ type: z.literal('existing'), path: z.string().min(1) }),
]);
export type StoredEndpoint = z.infer<typeof StoredEndpoint>;

/** A submitted Relationship once stored, with an app-assigned id. */
export const Relation = SubmittedRelation.omit({ from: true, to: true }).extend({
  id: z.string().min(1),
  from: StoredEndpoint,
  to: StoredEndpoint,
});
export type Relation = z.infer<typeof Relation>;

export const WrapUpProposal = z.object({
  sessionPath: z.string().min(1),
  generatedAt: z.number(),
  mentions: z.array(Mention),
  /** Absent in proposals stored before Relationships existed. */
  relations: z.array(Relation).default([]),
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
  | { status: 'invalid_suggestion_target'; characterPath: string }
  /** The Relationship at `index` cannot be resolved: a mention end that
   *  names nothing or two Mentions, or the same Note at both ends. (An
   *  existing end the caller cannot see is `not_found`.) */
  | { status: 'invalid_relation'; index: number; problem: RelationProblem };

export type RelationProblem = 'unknown_mention' | 'ambiguous_mention' | 'same_note';

const RELATION_PROBLEMS: Record<RelationProblem, string> = {
  unknown_mention: 'an end names a mention that is not in this submission',
  ambiguous_mention: 'an end names a mention that matches more than one mention',
  same_note: 'both ends are the same Note',
};

/** What to tell a client whose Relationship was refused, by position. */
export function describeRelationProblem(index: number, problem: RelationProblem): string {
  return `relations.${index}: ${RELATION_PROBLEMS[problem]}`;
}

/** Stores `mentions` as the Session's pending proposal, replacing any
 *  earlier one. An `existing` match must name a Note `role` may see;
 *  one that is missing or hidden reads as `not_found`, and so does an
 *  `existing` end of a Relationship. */
export function submitWrapUp(opts: {
  groupId: string;
  role: Role;
  submission: Omit<WrapUpSubmission, 'suggestions' | 'relations'> & {
    suggestions?: SubmittedSuggestion[];
    relations?: SubmittedRelation[];
  };
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

  const mentions = submission.mentions.map((m) => ({ ...m, id: newMentionId() }));
  const relations = resolveRelations(groupId, vis, mentions, submission.relations ?? []);
  if (!Array.isArray(relations)) return relations;

  const proposal: WrapUpProposal = {
    sessionPath: submission.sessionPath,
    generatedAt: Date.now(),
    mentions,
    relations,
    suggestions: suggestions.map((s) => ({ ...s, id: newSuggestionId() })),
  };
  writePendingWrapUpJson(groupId, submission.sessionPath, JSON.stringify(proposal));
  return { status: 'ok', proposal };
}

type ResolvedEnd =
  | { status: 'ok'; end: StoredEndpoint; identity: string }
  | { status: 'not_found' }
  | { status: 'invalid'; problem: RelationProblem };

/** Turns each submitted Relationship into its stored form, or the first
 *  reason it cannot be. A mention end is matched to a Mention of this
 *  submission by name, ignoring case. */
function resolveRelations(
  groupId: string,
  vis: Visibility,
  mentions: Mention[],
  submitted: SubmittedRelation[],
): Relation[] | { status: 'not_found' } | Extract<SubmitResult, { status: 'invalid_relation' }> {
  const resolveEnd = (end: SubmittedRelation['from']): ResolvedEnd => {
    if (end.type === 'existing') {
      const note = loadNote(groupId, end.path);
      if (!note || isHidden(note, vis)) return { status: 'not_found' };
      return { status: 'ok', end, identity: end.path };
    }
    const wanted = end.name.toLowerCase();
    const named = mentions.filter((m) => m.name.toLowerCase() === wanted);
    if (named.length === 0) return { status: 'invalid', problem: 'unknown_mention' };
    if (named.length > 1) return { status: 'invalid', problem: 'ambiguous_mention' };
    const mention = named[0]!;
    return {
      status: 'ok',
      end: { type: 'mention', mentionId: mention.id },
      // A mention that matched an existing Note is that Note.
      identity: mention.match.type === 'existing' ? mention.match.path : mention.id,
    };
  };

  const out: Relation[] = [];
  for (const [index, r] of submitted.entries()) {
    const from = resolveEnd(r.from);
    if (from.status === 'not_found') return from;
    if (from.status === 'invalid') return { status: 'invalid_relation', index, problem: from.problem };
    const to = resolveEnd(r.to);
    if (to.status === 'not_found') return to;
    if (to.status === 'invalid') return { status: 'invalid_relation', index, problem: to.problem };
    if (from.identity === to.identity) return { status: 'invalid_relation', index, problem: 'same_note' };
    out.push({
      id: newRelationId(),
      from: from.end,
      relation: r.relation,
      to: to.end,
      ...(r.note ? { note: r.note } : {}),
    });
  }
  return out;
}

function newRelationId(): string {
  return `r_${randomUUID().slice(0, 8)}`;
}

function newMentionId(): string {
  return `m_${randomUUID().slice(0, 8)}`;
}

function newSuggestionId(): string {
  return `s_${randomUUID().slice(0, 8)}`;
}

/** The stored proposal, with any existing-Note mentions `role` may not
 *  see removed, and with them every Relationship that depends on one or
 *  names a Note `role` may not see, so a GM's proposal never reveals a
 *  hidden Note to a Player who resumes it. */
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
  const mentions = proposal.mentions.filter((m) => m.match.type !== 'existing' || visible(m.match.path));
  const kept = new Set(mentions.map((m) => m.id));
  const endVisible = (end: StoredEndpoint): boolean =>
    end.type === 'mention' ? kept.has(end.mentionId) : visible(end.path);
  return {
    ...proposal,
    mentions,
    relations: proposal.relations.filter((r) => endVisible(r.from) && endVisible(r.to)),
    suggestions: proposal.suggestions.filter((s) => visible(s.characterPath)),
  };
}

export type PendingWrapUp = {
  sessionPath: string;
  title: string;
  generatedAt: number;
  mentions: number;
  relations: number;
  suggestions: number;
};

/** Every Session in the World with a proposal waiting for review that
 *  `role` may see, newest first, counted as `loadPendingWrapUp` would
 *  show it. Backs the header's "Wrap-up ready" notice. */
export function listPendingWrapUps(groupId: string, role: Role): PendingWrapUp[] {
  // One join gates every Session at once; only visible ones pay for
  // loadPendingWrapUp's per-mention checks.
  const rows = getDb()
    .query<
      { path: string; title: string; frontmatter_json: string; dm_only: number; gm_only: number },
      [string]
    >(
      `SELECT n.path, n.title, n.frontmatter_json, n.dm_only, n.gm_only
         FROM session_notes s
         JOIN notes n ON n.group_id = s.group_id AND n.path = s.note_path
        WHERE s.group_id = ? AND s.wrap_up_json IS NOT NULL`,
    )
    .all(groupId);
  const vis = visibilityFor(role);
  const out: PendingWrapUp[] = [];
  for (const row of rows) {
    if (isHidden(row, vis) || frontmatterKind(row.frontmatter_json) !== 'session') continue;
    const proposal = loadPendingWrapUp(groupId, role, row.path);
    if (!proposal) continue;
    out.push({
      sessionPath: row.path,
      title: row.title,
      generatedAt: proposal.generatedAt,
      mentions: proposal.mentions.length,
      relations: proposal.relations.length,
      suggestions: proposal.suggestions.length,
    });
  }
  return out.sort((a, b) => b.generatedAt - a.generatedAt);
}

/** Titles of the Notes a proposal points at (existing matches, existing
 *  Relationship ends and Suggestion Characters), for the review dialog's
 *  "Matched to <Title>?", its Relationships and its Suggestions list. Call it on a proposal from
 *  `loadPendingWrapUp`, which already dropped what the reader cannot see. */
export function existingTitles(groupId: string, proposal: WrapUpProposal): Record<string, string> {
  const paths = [
    ...proposal.mentions.flatMap((m) => (m.match.type === 'existing' ? [m.match.path] : [])),
    ...proposal.relations.flatMap((r) =>
      [r.from, r.to].flatMap((end) => (end.type === 'existing' ? [end.path] : [])),
    ),
    ...proposal.suggestions.map((s) => s.characterPath),
  ];
  const out: Record<string, string> = {};
  for (const path of paths) {
    const note = loadNote(groupId, path);
    if (note) out[path] = note.title;
  }
  return out;
}

/** For each mention that would create a new Note, the visible Notes with
 *  a close name that could take its History instead (at most 3, only
 *  kinds a mention can land on). Keyed by mention id; mentions with none
 *  are absent. Computed on read, never stored: the World moves on while
 *  a proposal waits. Call it on a proposal from `loadPendingWrapUp`. */
export function similarNotesFor(
  groupId: string,
  role: Role,
  proposal: WrapUpProposal,
): Record<string, SimilarNote[]> {
  const out: Record<string, SimilarNote[]> = {};
  let index: NameIndex | undefined;
  for (const mention of proposal.mentions) {
    if (mention.match.type !== 'new') continue;
    index ??= loadNameIndex({ groupId, role }).filter((e) => mentionKindOf(e.path, e.frontmatterJson) !== null);
    const matches = matchName(index, mention.match.title, 3);
    if (matches.length > 0) out[mention.id] = matches;
  }
  return out;
}

// ── Apply ──────────────────────────────────────────────────────────────

export type WrapUpDecisions = {
  /** Mention ids the closer ticked. */
  accepted: string[];
  /** Accepted mention ids whose uncertain match the closer switched to a new Note. */
  asNew: string[];
  /** Relationship ids the closer ticked. A Relationship also needs both
   *  of its ends to have landed. Absent means none. */
  acceptedRelations?: string[];
  /** Accepted mention ids whose History the closer sent to a different
   *  existing Note (mention id to path), e.g. a similarly named one the
   *  review offered in place of a new Note. Wins over `asNew`. A
   *  Relationship end on the mention follows it. */
  useExisting?: Record<string, string>;
};

/** `duplicate_target`: an earlier accepted mention in this apply already
 *  wrote this Session's History entry on the same Note (e.g. "Use Kixish
 *  instead" next to a mention of Kixish itself); its Relationships still
 *  resolve to that Note. `invalid_target`: the Note chosen with `useExisting` cannot receive
 *  History (a Character, a Session, a plain Note). `edit_failed`: the
 *  Note could not take the History entry (it vanished or refused the
 *  edit). `invalid_title`: nothing to name a new Note by. */
export type SkipReason =
  | 'unknown_mention'
  | 'not_visible'
  | 'invalid_target'
  | 'duplicate_target'
  | 'edit_failed'
  | 'invalid_title';

export type AppliedMention = { id: string; path: string; created: boolean };

/** `mention_not_applied`: a mention end was unticked or could not land.
 *  `not_visible`: an existing end is hidden from the closer or gone.
 *  `same_note`: both ends landed on one Note. */
export type RelationSkipReason =
  | 'unknown_relation'
  | 'mention_not_applied'
  | 'not_visible'
  | 'same_note';

export type ApplyResult = {
  applied: AppliedMention[];
  /** Accepted mentions that could not be applied, and why. */
  skipped: Array<{ id: string; reason: SkipReason }>;
  /** Relationships recorded; `unchanged` when one was already there. */
  relationsAdded: Array<{ id: string; status: 'added' | 'unchanged' }>;
  /** Ticked Relationships that could not be recorded, and why. */
  relationsSkipped: Array<{ id: string; reason: RelationSkipReason }>;
  /** Suggestions held for Characters' Players. */
  suggestions: StoredSuggestions;
};

/** Applies the closer's decisions on `proposal`, links the log, records
 *  the ticked Relationships, holds the proposal's Suggestions for their
 *  Players, closes the Session and clears its pending proposal. Running it again with the same proposal
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
  const useExisting = opts.decisions.useExisting ?? {};
  const campaign = campaignFor(groupId, session);

  const applied: AppliedMention[] = [];
  const skipped: ApplyResult['skipped'] = [];
  // Every mention that landed on a Note, including duplicates folded into
  // an earlier one, so Relationships on either resolve.
  const landed = new Map<string, string>();
  for (const id of new Set(opts.decisions.accepted)) {
    const mention = byId.get(id);
    if (!mention) {
      skipped.push({ id, reason: 'unknown_mention' });
      continue;
    }
    const target = await resolveTarget({
      groupId, userId, vis, mention, forceNew: asNew.has(id), campaign, session,
      useExisting: Object.hasOwn(useExisting, id) ? useExisting[id] : undefined,
    });
    if (target.status !== 'ok') {
      skipped.push({ id, reason: target.status });
      continue;
    }
    if (applied.some((a) => a.path === target.path)) {
      skipped.push({ id, reason: 'duplicate_target' });
      landed.set(id, target.path);
      continue;
    }
    const edit = await applyNoteEdit({
      groupId,
      path: target.path,
      userId,
      edit: (doc) =>
        addHistoryEntry(doc, { sessionPath, sessionTitle: session.title, text: mention.historyEntry }),
    });
    if (edit.status === 'rejected' || edit.status === 'not_found') {
      skipped.push({ id, reason: 'edit_failed' });
      continue;
    }
    applied.push({ id, path: target.path, created: target.created });
    landed.set(id, target.path);
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

  const isVisible = (path: string): boolean => {
    const note = loadNote(groupId, path);
    return note !== null && !isHidden(note, vis);
  };

  const { relationsAdded, relationsSkipped } = applyRelations({
    groupId,
    userId,
    sessionPath,
    proposal,
    accepted: opts.decisions.acceptedRelations ?? [],
    landed,
    isVisible,
  });

  const suggestions = storeSuggestions({
    groupId,
    sessionPath,
    suggestions: proposal.suggestions,
    isVisible,
  });

  closeSession(groupId, sessionPath, userId);
  return { applied, skipped, relationsAdded, relationsSkipped, suggestions };
}

/** Records each ticked Relationship whose two ends both landed: a mention
 *  end on the path its Mention was applied to, an existing end still
 *  visible. Anything else is skipped, never an error. */
function applyRelations(opts: {
  groupId: string;
  userId: string;
  sessionPath: string;
  proposal: WrapUpProposal;
  accepted: string[];
  /** Mention id to the path its History entry landed on. */
  landed: Map<string, string>;
  isVisible: (path: string) => boolean;
}): Pick<ApplyResult, 'relationsAdded' | 'relationsSkipped'> {
  const byId = new Map(opts.proposal.relations.map((r) => [r.id, r]));
  const relationsAdded: ApplyResult['relationsAdded'] = [];
  const relationsSkipped: ApplyResult['relationsSkipped'] = [];
  const resolve = (end: StoredEndpoint): { path: string } | { reason: RelationSkipReason } => {
    if (end.type === 'mention') {
      const path = opts.landed.get(end.mentionId);
      return path ? { path } : { reason: 'mention_not_applied' };
    }
    return opts.isVisible(end.path) ? { path: end.path } : { reason: 'not_visible' };
  };

  for (const id of new Set(opts.accepted)) {
    const relation = byId.get(id);
    if (!relation) {
      relationsSkipped.push({ id, reason: 'unknown_relation' });
      continue;
    }
    const from = resolve(relation.from);
    const to = resolve(relation.to);
    if ('reason' in from) {
      relationsSkipped.push({ id, reason: from.reason });
      continue;
    }
    if ('reason' in to) {
      relationsSkipped.push({ id, reason: to.reason });
      continue;
    }
    if (from.path === to.path) {
      relationsSkipped.push({ id, reason: 'same_note' });
      continue;
    }
    const { status } = addRelation({
      groupId: opts.groupId,
      from: from.path,
      relation: relation.relation,
      to: to.path,
      sessionPath: opts.sessionPath,
      userId: opts.userId,
    });
    relationsAdded.push({ id, status });
  }
  return { relationsAdded, relationsSkipped };
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

type Target =
  | { status: 'ok'; path: string; created: boolean }
  | { status: 'not_visible' | 'invalid_target' | 'invalid_title' };

/** The Note a mention lands on, creating it when it is new and nothing
 *  visible with that title or canonical path exists yet. An existing
 *  match, or a Note the closer chose instead, that they cannot see is
 *  `not_visible`: the same answer as one that does not exist.
 *
 *  A hidden Note at a new mention's canonical path is treated as if it
 *  were not there: the new Note takes the next free path, so neither
 *  the outcome nor the skip reason tells a Player the hidden Note
 *  exists. (Only a `-2` style suffix on the path hints at a collision.)
 *  A created Note is as hidden as the Session it came from. */
async function resolveTarget(opts: {
  groupId: string;
  userId: string;
  vis: Visibility;
  mention: Mention;
  forceNew: boolean;
  /** The closer's chosen Note for this mention, overriding its match. */
  useExisting?: string | undefined;
  campaign: Campaign;
  session: NoteRow;
}): Promise<Target> {
  const { groupId, userId, vis, mention, session } = opts;
  const match = mention.match;

  if (opts.useExisting !== undefined) {
    const note = loadNote(groupId, opts.useExisting);
    if (!note || isHidden(note, vis)) return { status: 'not_visible' };
    if (!mentionKindOf(note.path, note.frontmatter_json)) return { status: 'invalid_target' };
    return { status: 'ok', path: note.path, created: false };
  }

  if (match.type === 'existing' && !opts.forceNew) {
    const note = loadNote(groupId, match.path);
    return note && !isHidden(note, vis)
      ? { status: 'ok', path: match.path, created: false }
      : { status: 'not_visible' };
  }

  const title = match.type === 'new' ? match.title : mention.name;
  const summary = match.type === 'new' ? match.summary : '';
  if (!hasLetterOrDigit(title)) return { status: 'invalid_title' };
  const wanted = canonicalPath({
    kind: mention.kind,
    campaignSlug: opts.campaign?.slug,
    campaignRoot: opts.campaign?.folderPath,
    name: slugFor(title),
  });

  const atPath = loadNote(groupId, wanted);
  const landing =
    atPath && !isHidden(atPath, vis) ? atPath : findVisibleByTitle(groupId, vis, title, mention.kind);
  if (landing) return { status: 'ok', path: landing.path, created: false };

  // A hidden holder of the wanted path is never touched: take `-2`, `-3`, ...
  const made = await createNote(groupId, {
    userId,
    path: wanted,
    kind: mention.kind,
    title,
    markdown: summary,
    dmOnly: session.dm_only === 1,
    gmOnly: session.gm_only === 1,
    onTaken: (_taken, n) => ({ path: wanted.replace(/\.md$/, `-${n}.md`), title }),
  });
  if (made.status === 'exists') throw new Error(`No free path near ${wanted}`);
  await made.folderIndex;
  return { status: 'ok', path: made.path, created: true };
}

/** The path slug for a title. Titles with no Latin letters or digits
 *  (say, Cyrillic) fall back to a short hash of the title, so the same
 *  title always maps to the same path. */
function slugFor(title: string): string {
  const slug = slugify(title);
  if (slug) return slug;
  return `note-${createHash('sha1').update(title.trim().toLowerCase()).digest('hex').slice(0, 8)}`;
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
