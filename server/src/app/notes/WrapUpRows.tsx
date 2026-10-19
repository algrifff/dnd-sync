'use client';

import { useId } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  Ghost,
  History,
  Link2,
  MapPin,
  Package,
  Plus,
  ScrollText,
  Send,
  Sparkles,
  User,
  type LucideIcon,
} from 'lucide-react';
import type { Mention, WrapUpProposal } from '@/lib/wrap-up';
import { MENTION_KIND_LABELS } from '@compendium/shared';
import type { SimilarNote } from '@/lib/similar-names';
import { WrapUpTick } from './WrapUpTick';
import {
  groupRows,
  itemsLabel,
  relationRows,
  setAccepted,
  setAsNew,
  setRelationAccepted,
  setUseExisting,
  type RelationReview,
  type RelationRow,
  type ReviewRow,
  type ReviewState,
} from './wrap-up-review';

const KIND_LOOK: Record<Mention['kind'], { Icon: LucideIcon; tile: string }> = {
  person: { Icon: User, tile: 'bg-[rgb(var(--sage-rgb)/0.18)] text-[var(--sage)]' },
  creature: { Icon: Ghost, tile: 'bg-[rgb(var(--embers-rgb)/0.16)] text-[var(--embers)]' },
  location: { Icon: MapPin, tile: 'bg-[rgb(var(--moss-rgb)/0.2)] text-[var(--moss)]' },
  item: { Icon: Package, tile: 'bg-[rgb(var(--candlelight-rgb)/0.2)] text-[var(--candlelight)]' },
  quest: { Icon: ScrollText, tile: 'bg-[rgb(var(--wine-rgb)/0.14)] text-[var(--wine)]' },
  lore: { Icon: BookOpen, tile: 'bg-[rgb(var(--ink-soft-rgb)/0.14)] text-[var(--ink-soft)]' },
};

const WRAP = '[overflow-wrap:anywhere]';

/** "person" -> "Person"; kinds outside the mention list read as written. */
const SIMILAR_KIND = (kind: string): string =>
  MENTION_KIND_LABELS[kind as Mention['kind']] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
const STRUCK = 'line-through decoration-[var(--ink-muted)] decoration-1';

function rowStyle(i: number, dim?: number): React.CSSProperties {
  return { '--i': Math.min(i, 10), '--d': `${Math.min(dim ?? 0, 6) * 24}ms` } as React.CSSProperties;
}

export function ReviewList({
  proposal,
  titles,
  similar,
  review,
  relationsOff,
  disabled,
  onChange,
  onRelationsChange,
}: {
  proposal: WrapUpProposal;
  titles: Record<string, string>;
  /** Per new-Note mention id: visible Notes with a close name. */
  similar: Record<string, SimilarNote[]>;
  review: ReviewState;
  relationsOff: RelationReview;
  disabled: boolean;
  onChange: (next: ReviewState) => void;
  onRelationsChange: (next: RelationReview) => void;
}): React.JSX.Element {
  const { fresh, history } = groupRows(proposal, review);
  const relations = relationRows(proposal, review, relationsOff, titles);

  const renderMention = (row: ReviewRow, i: number): React.JSX.Element => (
    <MentionRow
      key={row.mention.id}
      row={row}
      index={i}
      titles={titles}
      similar={similar[row.mention.id] ?? []}
      disabled={disabled}
      onToggle={(accepted) => onChange(setAccepted(review, row.mention.id, accepted))}
      onSwitch={(asNew) => onChange(setAsNew(review, row.mention.id, asNew))}
      onUseExisting={(path) => onChange(setUseExisting(review, row.mention.id, path))}
    />
  );

  return (
    <div className="space-y-2">
      {fresh.length > 0 && (
        <Section
          Icon={Sparkles}
          label="New notes"
          ticked={fresh.filter((r) => r.accepted).length}
          total={fresh.length}
        >
          {fresh.map(renderMention)}
        </Section>
      )}
      {history.length > 0 && (
        <Section
          Icon={History}
          label="History"
          ticked={history.filter((r) => r.accepted).length}
          total={history.length}
        >
          {history.map((row, i) => renderMention(row, i + fresh.length))}
        </Section>
      )}
      {relations.length > 0 && (
        <Section
          Icon={Link2}
          label="Relationships"
          ticked={relations.filter((r) => r.accepted).length}
          total={relations.length}
        >
          {relations.map((row, i) => (
            <RelationshipRow
              key={row.relation.id}
              row={row}
              index={i + fresh.length + history.length}
              disabled={disabled}
              onToggle={(accepted) =>
                onRelationsChange(setRelationAccepted(relationsOff, row.relation.id, accepted))
              }
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  Icon,
  label,
  ticked,
  total,
  children,
}: {
  Icon: LucideIcon;
  label: string;
  ticked: number;
  total: number;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <SectionHead id={headingId} Icon={Icon} label={label} ticked={ticked} total={total} />
      <ul className="space-y-0.5 pb-2">{children}</ul>
    </section>
  );
}

function SectionHead({
  id,
  Icon,
  label,
  ticked,
  total,
}: {
  id: string;
  Icon: LucideIcon;
  label: string;
  ticked: number;
  total: number;
}): React.JSX.Element {
  return (
    <h4
      id={id}
      className="wu-head flex items-center gap-2 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]"
    >
      <Icon size={14} strokeWidth={2.25} aria-hidden className="text-[var(--wine)]" />
      {label}
      <span className="wu-chip tabular-nums normal-case tracking-normal">
        <span>
          <span key={ticked} className="wu-num">{ticked}</span>
          {ticked !== total && <span className="text-[var(--ink-muted)]">/{total}</span>}
        </span>
      </span>
    </h4>
  );
}

function RelationshipRow({
  row,
  index,
  disabled,
  onToggle,
}: {
  row: RelationRow;
  index: number;
  disabled: boolean;
  onToggle: (accepted: boolean) => void;
}): React.JSX.Element {
  const Arrow = row.symmetric ? ArrowLeftRight : ArrowRight;
  return (
    <li
      className="wu-row wu-enter rounded-[10px] px-2 hover:bg-[var(--parchment)]"
      data-off={!row.accepted}
      style={rowStyle(index, index)}
    >
      <label
        className={`flex min-h-[44px] items-start gap-3 py-2.5 ${row.blocked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span className="pt-px">
          <WrapUpTick
            label={`${row.from} ${row.label} ${row.to}`}
            checked={row.accepted}
            blocked={row.blocked}
            disabled={disabled || row.blocked}
            onChange={onToggle}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`wu-title font-medium text-[var(--ink)] ${WRAP} ${row.fromOff ? STRUCK : ''}`}>
              {row.from}
            </span>
            <span className="wu-chip">
              {row.label}
              <Arrow size={11} strokeWidth={2.5} aria-hidden />
            </span>
            <span className={`wu-title font-medium text-[var(--ink)] ${WRAP} ${row.toOff ? STRUCK : ''}`}>
              {row.to}
            </span>
          </span>
          {row.relation.note && (
            <span className={`mt-0.5 block text-xs italic text-[var(--ink-soft)] ${WRAP}`}>
              {row.relation.note}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

function MentionRow({
  row,
  index,
  titles,
  similar,
  disabled,
  onToggle,
  onSwitch,
  onUseExisting,
}: {
  row: ReviewRow;
  index: number;
  titles: Record<string, string>;
  similar: SimilarNote[];
  disabled: boolean;
  onToggle: (accepted: boolean) => void;
  onSwitch: (asNew: boolean) => void;
  /** A similar Note's path to use it, null to go back to a new Note. */
  onUseExisting: (path: string | null) => void;
}): React.JSX.Element {
  const { mention, destination } = row;
  const kind = MENTION_KIND_LABELS[mention.kind];
  const { Icon, tile } = KIND_LOOK[mention.kind];
  const matchedTitle =
    mention.match.type === 'existing' ? (titles[mention.match.path] ?? mention.match.path) : null;
  const uncertain = mention.match.type === 'existing' && !mention.match.certain;
  const chosen = destination.type === 'existing' && destination.chosen;
  const chosenPath = destination.type === 'existing' && destination.chosen ? destination.path : null;
  const chosenTitle = chosenPath ? (titles[chosenPath] ?? chosenPath) : null;
  // Only a mention the Wrap-up would create a Note for is offered a similar one.
  const offerSimilar = mention.match.type === 'new' && similar.length > 0;
  const heading =
    destination.type === 'new'
      ? destination.title
      : chosenTitle ?? (uncertain ? mention.name : (matchedTitle ?? mention.name));
  const switched = destination.type === 'new' && destination.switched;

  return (
    <li
      className={`wu-row wu-enter rounded-[10px] px-2 hover:bg-[var(--parchment)] ${switched ? 'wu-arrive' : ''}`}
      data-off={!row.accepted}
      style={rowStyle(index)}
    >
      <label className="flex min-h-[44px] cursor-pointer items-start gap-3 py-2.5">
        <span className="pt-1.5">
          <WrapUpTick
            label={`${heading}, ${kind}`}
            checked={row.accepted}
            disabled={disabled}
            onChange={onToggle}
          />
        </span>
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-[9px] ${tile}`} aria-hidden>
          <Icon size={16} strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`wu-title block font-medium text-[var(--ink)] ${WRAP} ${row.accepted ? '' : STRUCK}`}>
            {heading}
          </span>
          {destination.type === 'new' && destination.summary && (
            <span className={`block text-xs text-[var(--ink-soft)] ${WRAP}`}>{destination.summary}</span>
          )}
          <span className={`block text-xs text-[var(--ink-muted)] ${WRAP}`}>{mention.historyEntry}</span>
        </span>
      </label>
      {offerSimilar && !chosen && (
        <ul className="space-y-1 pb-2.5 pl-[calc(22px+0.75rem+32px+0.75rem)]">
          {similar.map((s) => (
            <li key={s.path} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ink-soft)]">
              <span className={WRAP}>
                Similar: <strong className="font-semibold text-[var(--ink)]">{s.title}</strong>
                <span className="text-[var(--ink-muted)]"> ({SIMILAR_KIND(s.kind)})</span>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onUseExisting(s.path)}
                className="wu-chip cursor-pointer disabled:opacity-40"
              >
                <Link2 size={11} aria-hidden />
                Use {s.title} instead
              </button>
            </li>
          ))}
        </ul>
      )}
      {offerSimilar && chosenTitle && (
        <div className="pb-2.5 pl-[calc(22px+0.75rem+32px+0.75rem)]">
          <div className="wu-seg" role="group" aria-label={`Where ${mention.name} goes`}>
            <button type="button" disabled={disabled} aria-pressed onClick={() => chosenPath && onUseExisting(chosenPath)}>
              <Link2 size={12} aria-hidden className="shrink-0" />
              <span>{chosenTitle}</span>
            </button>
            <button type="button" disabled={disabled} aria-pressed={false} onClick={() => onUseExisting(null)}>
              <Plus size={12} aria-hidden className="shrink-0" />
              <span>{kind}</span>
              <span className="sr-only"> new</span>
            </button>
          </div>
        </div>
      )}
      {uncertain && matchedTitle && (
        <div className="pb-2.5 pl-[calc(22px+0.75rem+32px+0.75rem)]">
          <div className="wu-seg" role="group" aria-label={`Where ${mention.name} goes`}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={destination.type === 'existing'}
              onClick={() => onSwitch(false)}
            >
              <Link2 size={12} aria-hidden className="shrink-0" />
              <span>{matchedTitle}</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={destination.type === 'new'}
              onClick={() => onSwitch(true)}
            >
              <Plus size={12} aria-hidden className="shrink-0" />
              <span>{kind}</span>
              <span className="sr-only"> new</span>
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Read-only: Suggestions are not the closer's to accept. Each goes to
 *  its Character's Player, who accepts or dismisses it. */
export function SuggestionsNotice({
  proposal,
  titles,
}: {
  proposal: WrapUpProposal;
  titles: Record<string, string>;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-2">
      <SectionHead
        id={headingId}
        Icon={Send}
        label="Suggestions"
        ticked={proposal.suggestions.length}
        total={proposal.suggestions.length}
      />
      <ul className="space-y-2 pb-2">
        {proposal.suggestions.map((s, i) => (
          <li
            key={s.id}
            className="wu-enter flex items-start gap-3 rounded-[10px] border border-dashed border-[var(--ink-muted)]/50 bg-[var(--parchment-sunk)]/50 px-3 py-2.5"
            style={rowStyle(i)}
          >
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[rgb(var(--sage-rgb)/0.18)] text-[var(--sage)]"
              aria-hidden
            >
              <User size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block font-medium text-[var(--ink)] ${WRAP}`}>
                {titles[s.characterPath] ?? s.characterPath}
              </span>
              {s.story && <span className={`block text-xs text-[var(--ink-soft)] ${WRAP}`}>{s.story}</span>}
              {s.items.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className="sr-only">{itemsLabel(s.items)}</span>
                  {s.items.map((item) => (
                    <span key={item.name} className="wu-chip" aria-hidden>
                      <Package size={11} strokeWidth={2.25} />
                      {item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
