// Shared types for the import skill suite.
//
// The classifier + extractor produce results that we stitch together
// into a single PlannedNote.classification shape — the same data the
// apply pipeline, review UI, and chat summary all consume. Keeping
// the composite shape here means consumers don't need to know which
// skill produced which field.

import type { ClassifyResult } from './classify';

export type { ClassifyResult } from './classify';
export type { ExtractResult } from './extract';
export type { MergeInput, MergeResult } from './merge';

/** Per-note plan entry. Composite of the classifier's per-note
 *  metadata and the kind-specific extract's sheet fields. */
export type ImportClassifyResult = ClassifyResult & {
  sheet: Record<string, unknown>;
};
