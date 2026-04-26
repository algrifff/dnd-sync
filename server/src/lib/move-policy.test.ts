import { describe, expect, it } from 'bun:test';
import {
  assertMoveAllowed,
  canDropOn,
  isDraggableSource,
  pathAfterMove,
} from './move-policy';

describe('move-policy', () => {
  describe('PC lock', () => {
    it('blocks moving a PC file out of Characters', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Characters/Bob.md',
        to: 'Campaigns/X/People/Bob.md',
      });
      expect(r).toEqual({ ok: false, error: 'pc_locked', reason: expect.any(String) });
    });

    it('blocks moving a folder under Characters', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/Characters/Heroes',
        to: 'Campaigns/X/People/Heroes',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('pc_locked');
    });

    it('blocks moves *into* Characters too', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Sneaky.md',
        to: 'Campaigns/X/Characters/Sneaky.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('characters_locked');
    });

    it('allows PC → Characters in another campaign', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Characters/Bob.md',
        to: 'Campaigns/Y/Characters/Bob.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows a folder under Characters to move to another campaign Characters', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/Characters/Heroes',
        to: 'Campaigns/Y/Characters/Heroes',
      });
      expect(r).toEqual({ ok: true });
    });

    it('flags PC source as draggable so it can be dropped into another Characters folder', () => {
      expect(isDraggableSource({ kind: 'file', path: 'Campaigns/X/Characters/Bob.md' })).toBe(true);
    });
  });

  describe('campaign + canonical folder lock', () => {
    it('blocks moving a campaign root folder', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X',
        to: 'Campaigns/Y',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('campaign_locked');
    });

    it('blocks moving the Enemies canonical folder', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/Enemies',
        to: 'Campaigns/X/Bad Guys',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('canonical_folder_locked');
    });

    it('blocks moving the World Lore/World Info canonical folder', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'World Lore/World Info',
        to: 'World Lore/Info',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('canonical_folder_locked');
    });

    it('blocks the bare Campaigns heading', () => {
      const r = assertMoveAllowed({ kind: 'folder', from: 'Campaigns', to: 'Stuff/Campaigns' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('top_level_locked');
    });
  });

  describe('cross-section moves (NPC → Enemy etc.)', () => {
    it('allows ally → Enemies', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Renegade.md',
        to: 'Campaigns/X/Enemies/Renegade.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows item → Loot subfolder created by user', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Loot/Sword.md',
        to: 'Campaigns/X/Loot/Magical/Sword.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows campaign NPC → World Lore', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Old Sage.md',
        to: 'World Lore/Old Sage.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows World Lore item → campaign Loot', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'World Lore/Crown.md',
        to: 'Campaigns/X/Loot/Crown.md',
      });
      expect(r).toEqual({ ok: true });
    });
  });

  describe('top-level / asset destinations', () => {
    it('blocks dropping at the bare vault root', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Bob.md',
        to: 'Bob.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_destination');
    });

    it('blocks dropping directly under Campaigns', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Bob.md',
        to: 'Campaigns/Bob.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_destination');
    });

    it('allows dropping directly into World Lore (it is a section, not a bare heading)', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Bob.md',
        to: 'World Lore/Bob.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows dropping under a World Lore subfolder', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Bob.md',
        to: 'World Lore/World Info/Bob.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('blocks dropping into Assets', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Loot/Sword.md',
        to: 'Assets/Sword.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_destination');
    });
  });

  describe('session confinement', () => {
    it('allows session move within same Adventure Log subfolder', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Adventure Log/Session 1.md',
        to: 'Campaigns/X/Adventure Log/Arc 1/Session 1.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('blocks session → People', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Adventure Log/Session 1.md',
        to: 'Campaigns/X/People/Session 1.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('session_outside_adventure_log');
    });

    it('blocks session → World Lore', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Adventure Log/Session 1.md',
        to: 'World Lore/World Info/Session 1.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('session_outside_adventure_log');
    });

    it('allows session → other campaign Adventure Log', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Adventure Log/Session 1.md',
        to: 'Campaigns/Y/Adventure Log/Session 1.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows session → other campaign Adventure Log subfolder', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Adventure Log/Session 1.md',
        to: 'Campaigns/Y/Adventure Log/Arc 1/Session 1.md',
      });
      expect(r).toEqual({ ok: true });
    });

    it('blocks non-session → Adventure Log', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/People/Bob.md',
        to: 'Campaigns/X/Adventure Log/Bob.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adventure_log_locked');
    });

    it('blocks non-session → other campaign Adventure Log', () => {
      const r = assertMoveAllowed({
        kind: 'file',
        from: 'Campaigns/X/Loot/Sword.md',
        to: 'Campaigns/Y/Adventure Log/Sword.md',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adventure_log_locked');
    });

    it('blocks user folder → Adventure Log', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/People/Allies',
        to: 'Campaigns/X/Adventure Log/Allies',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('adventure_log_locked');
    });
  });

  describe('folder moves', () => {
    it('blocks folder into itself', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/People/Allies',
        to: 'Campaigns/X/People/Allies/Inner',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('cannot_move_into_self');
    });

    it('allows a user-made folder to move between sibling sections', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/People/Mercenaries',
        to: 'Campaigns/X/Enemies/Mercenaries',
      });
      expect(r).toEqual({ ok: true });
    });

    it('allows a folder under Adventure Log to be reorganised within Adventure Log', () => {
      const r = assertMoveAllowed({
        kind: 'folder',
        from: 'Campaigns/X/Adventure Log/Arc 1',
        to: 'Campaigns/X/Adventure Log/Old/Arc 1',
      });
      expect(r).toEqual({ ok: true });
    });
  });

  describe('helpers', () => {
    it('pathAfterMove builds the right destination path', () => {
      expect(pathAfterMove('Campaigns/X/People/Bob.md', 'Campaigns/X/Enemies')).toBe(
        'Campaigns/X/Enemies/Bob.md',
      );
    });

    it('canDropOn agrees with assertMoveAllowed', () => {
      const ok = canDropOn(
        { kind: 'file', path: 'Campaigns/X/People/Bob.md' },
        'Campaigns/X/Enemies',
      );
      expect(ok).toEqual({ ok: true });
      const blocked = canDropOn(
        { kind: 'file', path: 'Campaigns/X/Characters/Bob.md' },
        'Campaigns/X/People',
      );
      expect(blocked.ok).toBe(false);
    });

    it('isDraggableSource gates locked sources', () => {
      expect(isDraggableSource({ kind: 'folder', path: 'Campaigns' })).toBe(false);
      // Campaign roots are draggable for sibling-reorder. They still
      // fail canDropOn for any folder destination so they cannot be
      // nested — the only legal drop is a between-rows reorder gap.
      expect(isDraggableSource({ kind: 'folder', path: 'Campaigns/X' })).toBe(true);
      expect(isDraggableSource({ kind: 'folder', path: 'Campaigns/X/Enemies' })).toBe(false);
      // PC files are draggable now — canDropOn keeps them confined to
      // other Characters/ folders rather than blocking the drag itself.
      expect(isDraggableSource({ kind: 'file', path: 'Campaigns/X/Characters/Bob.md' })).toBe(true);
      expect(isDraggableSource({ kind: 'file', path: 'Campaigns/X/People/Bob.md' })).toBe(true);
      expect(isDraggableSource({ kind: 'folder', path: 'World Lore/World Info' })).toBe(false);
      expect(isDraggableSource({ kind: 'folder', path: 'World Lore/Custom' })).toBe(true);
    });
  });
});
