'use client';

// The Orrery's panels: masthead and legend on the left, controls on the
// right, breadcrumb, selection card, jump-to-note search and the
// keyboard shortcuts. All state lives in the engine (see engine.ts);
// this reads its snapshot and sends actions back.

import Link from 'next/link';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { RELATION_TYPES, type RelationType } from '@compendium/shared';
import type { Engine } from './engine';
import { campaignLabel, KIND_ORDER, searchNotes, type Model, type ONode } from './layout';
import {
  capitalise,
  KIND_LABEL,
  kindColor,
  kindSingular,
  kindTextColor,
  REL_STYLE,
  relLabel,
  type Palette,
} from './palette';
import s from './orrery.module.css';

interface Props {
  engine: Engine;
  model: Model;
  worldName: string;
  campNames: Readonly<Record<string, string>>;
  palette: Palette;
  onOpen(id: string): void;
}

const trunc = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function RelSwatch({ type, palette, w = 26 }: { type: RelationType; palette: Palette; w?: number }): ReactElement {
  const d = REL_STYLE[type];
  const color = palette[d.color];
  return (
    <svg width={w} height={10} aria-hidden="true">
      <line x1={1} y1={5} x2={w - (d.dir ? 3 : 1)} y2={5} stroke={color} strokeWidth={d.w} strokeDasharray={d.dash.join(' ')} />
      {d.diamond ? (
        <path d={`M${w - 9} 5 l3.5 -2.5 l3.5 2.5 l-3.5 2.5z`} fill={color} />
      ) : d.dir ? (
        <path d={`M${w - 6} 2 l4 3 l-4 3`} fill="none" stroke={color} strokeWidth={1.1} />
      ) : null}
    </svg>
  );
}

function OrreryChromeImpl({ engine, model, worldName, campNames, palette, onOpen }: Props): ReactElement {
  const S = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const label = (c: string): string => campaignLabel(c, campNames);

  const stats = useMemo(() => {
    const kinds = new Map<string, number>();
    const camps = new Map<string, number>();
    for (const n of model.nodes) {
      if (n.isIndex) continue;
      kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
      camps.set(n.campaign, (camps.get(n.campaign) ?? 0) + 1);
    }
    const rel = new Map<RelationType, number>();
    for (const r of model.rels) rel.set(r.type, (rel.get(r.type) ?? 0) + 1);
    return { kinds, camps, rel };
  }, [model]);

  // ── search
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (searching ? searchNotes(model, query) : []), [model, query, searching]);
  const openSearch = (): void => {
    setQuery('');
    setSel(0);
    setSearching(true);
  };
  const closeSearch = (): void => setSearching(false);
  const pickHit = (n: ONode | undefined): void => {
    if (!n) return;
    closeSearch();
    engine.focusNote(n);
  };
  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  // ── keyboard
  const keys = useRef({ S, searching });
  keys.current = { S, searching };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const { S: st, searching: open } = keys.current;
      if (open) return;
      if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) {
        // Ahead of the app-wide Ctrl+K world search: here it jumps within the graph.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        openSearch();
        return;
      }
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (ev.ctrlKey || ev.metaKey) return;
      if (ev.key === '/') {
        ev.preventDefault();
        openSearch();
      } else if (ev.key === 'Escape') {
        if (st.focus) engine.toWheel(st.drill);
        else if (st.drill) engine.drill(st.drill);
      } else if (ev.key === 'f' || ev.key === 'F') engine.fit();
      else if (ev.altKey && ev.key === 'ArrowLeft') engine.histGo(-1);
      else if (ev.altKey && ev.key === 'ArrowRight') engine.histGo(1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [engine]);

  // ── breadcrumb
  const camp = S.focus ? S.focus.campaign : S.drill;
  const trail = S.focus ? S.hist.slice(Math.max(0, S.hi - 2), S.hi + 1) : [];

  const kindList = KIND_ORDER.filter((k) => stats.kinds.get(k));
  const rails = S.focus ? S.focusInfo : null;
  const hid = rails
    ? [
        rails.hidden.index && `${rails.hidden.index} index`,
        rails.hidden.session && `${rails.hidden.session} session${rails.hidden.session > 1 ? 's' : ''}`,
        rails.hidden.filtered && `${rails.hidden.filtered} filtered`,
      ].filter(Boolean)
    : [];
  const f = S.focus;

  return (
    <>
      <header className={s.mast}>
        <div className={s.mark}>
          COM—<br />PEN—<br />DIUM+
        </div>
        <div className={s.rule} />
        <h1 className={s.title}>
          The Orrery
          <br />
          of {worldName || 'the World'}
        </h1>
        <div className={`${s.meta} ${s.caps}`}>
          <span><b>{model.nodes.length.toLocaleString()}</b>notes</span>
          <span><b>{model.links.length.toLocaleString()}</b>links</span>
          <span><b>{model.camps.length}</b>groups</span>
        </div>
      </header>

      <nav className={s.crumbs} aria-label="Graph position">
        <button className={s.nav} title="Back (Alt+←)" aria-label="Back" disabled={!(S.hi > 0 && S.focus)} onClick={() => engine.histGo(-1)}>◀</button>
        <button className={s.nav} title="Forward (Alt+→)" aria-label="Forward" disabled={!(S.focus && S.hi < S.hist.length - 1)} onClick={() => engine.histGo(1)}>▶</button>
        <button className={`${s.crumb} ${s.world} ${!S.focus && !S.drill ? s.cur : ''}`} onClick={() => engine.toWheel(null)}>{worldName || 'World'}</button>
        {camp ? (
          <>
            <span className={s.sep}>›</span>
            <button className={`${s.crumb} ${!S.focus ? s.cur : ''}`} onClick={() => engine.toWheel(camp)}>{label(camp)}</button>
          </>
        ) : null}
        {S.focus && S.hi > 2 ? (
          <>
            <span className={s.sep}>›</span>
            <span className={s.sep}>…</span>
          </>
        ) : null}
        {trail.map((n, j) => (
          <span key={`${S.hi}-${j}`} style={{ display: 'contents' }}>
            <span className={s.sep}>›</span>
            <button className={`${s.crumb} ${j === trail.length - 1 ? s.cur : ''}`} onClick={() => engine.histJump(S.hi - (trail.length - 1 - j))}>{trunc(n.title, 30)}</button>
          </span>
        ))}
      </nav>

      <aside className={s.controls} aria-label="Graph controls">
        <h3 className={s.caps}>Links</h3>
        <div className={s.seg}>
          <button className={S.linkMode === 'grouped' ? s.on : ''} onClick={() => engine.setLinkMode('grouped')}>Grouped</button>
          <button className={S.linkMode === 'all' ? s.on : ''} onClick={() => engine.setLinkMode('all')}>Every link</button>
        </div>
        <h3 className={s.caps}>Hygiene</h3>
        <label className={s.tog}>
          <span>Index notes <small>hub spokes</small></span>
          <input type="checkbox" checked={S.showIndex} onChange={(e) => engine.setShowIndex(e.target.checked)} />
        </label>
        <label className={s.tog}>
          <span>Sessions <small>outer arc</small></span>
          <input type="checkbox" checked={S.showSessions} onChange={(e) => engine.setShowSessions(e.target.checked)} />
        </label>
        <label className={s.tog}>
          Relationships
          <input type="checkbox" checked={S.showRelations} onChange={(e) => engine.setShowRelations(e.target.checked)} />
        </label>
        <h3 className={s.caps}>Kinds</h3>
        <div className={s.chips}>
          {kindList.map((k) => (
            <button key={k} className={`${s.chip} ${S.kinds.has(k) ? '' : s.off}`} title="Alt-click to show only this kind" onClick={(ev) => engine.toggleKind(k, ev.altKey || ev.metaKey)}>
              <i style={{ background: kindColor(palette, k) }} />
              {KIND_LABEL[k]} {stats.kinds.get(k)}
            </button>
          ))}
        </div>
        <h3 className={s.caps}>Campaigns</h3>
        <div className={`${s.chips} ${s.campChips}`}>
          {model.camps.map((c) => (
            <button key={c} className={`${s.chip} ${S.camps.has(c) ? '' : s.off}`} title={`${label(c)} (alt-click to show only this one)`} onClick={(ev) => engine.toggleCamp(c, ev.altKey || ev.metaKey)}>
              {label(c).replace(/ &.*$/, '')}
              <span>{stats.camps.get(c) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className={s.row}>
          <button className={s.btn} onClick={openSearch}>Search <kbd>/</kbd></button>
          <button className={s.btn} onClick={() => engine.fit()}>Fit <kbd>F</kbd></button>
          <button className={s.btn} onClick={() => engine.reset()}>Reset</button>
        </div>
        <Link href="/graph/classic" className={s.classic}>Classic view</Link>
      </aside>

      <aside className={s.legend} aria-label="Legend">
        <div className={s.caps}>Number of links</div>
        <div className={s.sizes}>
          {[1, 10, 40, 80].map((d) => {
            const r = (1.3 + Math.sqrt(d) * 0.62) * 1.6;
            return (
              <div key={d}>
                <span style={{ width: 2 * r, height: 2 * r }} />
                {d}
              </div>
            );
          })}
          <div>
            <span className={s.hubKey} style={{ borderRadius: 0 }} />
            index hub
          </div>
        </div>
        <div className={s.caps} style={{ marginBottom: 5 }}>
          Relationships <span style={{ letterSpacing: 0, textTransform: 'none' }}>(click to filter)</span>
        </div>
        {RELATION_TYPES.map((t) => (
          <button key={t} className={`${s.rel} ${S.relTypes.has(t) ? '' : s.off}`} onClick={() => engine.toggleRelType(t)}>
            <RelSwatch type={t} palette={palette} />
            <span>{capitalise(relLabel(t, true))}</span>
            <em>{stats.rel.get(t) ?? 0}</em>
          </button>
        ))}
      </aside>

      {f ? (
        <section className={s.card} aria-label="Selected note">
          <div className={s.caps} style={{ color: kindTextColor(palette, f.isIndex ? 'index' : f.kind) }}>
            {f.isIndex ? 'Index note' : kindSingular(f.kind)} · {label(f.campaign)}
          </div>
          <h2>{f.title}</h2>
          <div className={s.m}>
            {f.degree} links · {f.rels.length} relationships
            {rails ? ` · ring 1: ${rails.ring1} · ring 2: ${rails.ring2}${rails.overflow ? ` (+${rails.overflow})` : ''}` : ''}
          </div>
          {f.tags.length ? <div className={s.m}>#{f.tags.join('  #')}</div> : null}
          {f.rels.length ? (
            <ul>
              {f.rels.map((r, i) => {
                const other = r.s === f ? r.t : r.s;
                return (
                  <li key={`${other.id}-${r.type}-${i}`}>
                    <RelSwatch type={r.type} palette={palette} w={22} />
                    <span>{relLabel(r.type, r.s === f)}</span>
                    <button onClick={() => engine.focusNote(other)}>{other.title}</button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {rails && rails.ring1 === 0 ? (
            <div className={s.hid}>{f.degree || f.rels.length ? 'Its links are all filtered out.' : 'Nothing links to or from this note yet.'}</div>
          ) : null}
          {hid.length ? <div className={s.hid}>Not on the rings: {hid.join(', ')} linked notes. Use the toggles to show them.</div> : null}
          <div className={s.path}>{f.id}</div>
          <button className={s.open} onClick={() => onOpen(f.id)}>Open note</button>
        </section>
      ) : null}

      {searching ? (
        <div className={s.search} onMouseDown={(ev) => { if (ev.target === ev.currentTarget) closeSearch(); }}>
          <div className={s.box} role="dialog" aria-label="Jump to a note">
            <input
              ref={inputRef}
              value={query}
              placeholder="Jump to a note…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => { setQuery(e.target.value); setSel(0); }}
              onKeyDown={(ev) => {
                if (ev.key === 'ArrowDown') { setSel(Math.min(hits.length - 1, sel + 1)); ev.preventDefault(); }
                else if (ev.key === 'ArrowUp') { setSel(Math.max(0, sel - 1)); ev.preventDefault(); }
                else if (ev.key === 'Enter') pickHit(hits[sel]);
                else if (ev.key === 'Escape') { closeSearch(); ev.stopPropagation(); }
              }}
            />
            <ol>
              {hits.length ? (
                hits.map((n, i) => (
                  <li key={n.id} className={i === sel ? s.sel : ''} onMouseDown={(ev) => { ev.preventDefault(); pickHit(n); }}>
                    <i style={{ background: kindColor(palette, n.isIndex ? 'index' : n.kind) }} />
                    {n.title}
                    <small>{label(n.campaign)}</small>
                  </li>
                ))
              ) : (
                <li className={s.none}>No note by that name</li>
              )}
            </ol>
            <div className={s.hint}>↑↓ to choose · Enter to centre · Esc to close</div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export const OrreryChrome = memo(OrreryChromeImpl);
