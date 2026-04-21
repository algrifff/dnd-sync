// Unified derivation: every save pipeline (Yjs, AI tools, import, API
// routes) calls this after writing a note's frontmatter so all
// five index tables (characters, items, locations, creatures, session_notes)
// + the campaigns registry stay in sync. Idempotent for every kind.

import { deriveCharacterFromFrontmatter, ensureCampaignForPath } from './characters';
import { deriveItemFromFrontmatter } from './items';
import { deriveLocationFromFrontmatter } from './locations';
import { deriveCreatureFromFrontmatter } from './creatures';
import { deriveSessionFromFrontmatter } from './sessions';

export function deriveAllIndexes(opts: {
  groupId: string;
  notePath: string;
  frontmatterJson: string;
}): void {
  ensureCampaignForPath(opts.groupId, opts.notePath);
  deriveCharacterFromFrontmatter(opts);
  deriveSessionFromFrontmatter(opts);
  deriveItemFromFrontmatter(opts);
  deriveLocationFromFrontmatter(opts);
  deriveCreatureFromFrontmatter(opts);
}
