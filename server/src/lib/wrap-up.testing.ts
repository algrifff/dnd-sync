// Test-only: apply a hand-built proposal through the real interface.
// Stores `proposal` as the pending one on `sessionPath`, then applies it
// with its own `generatedAt`, so tests can arrange ids they choose
// without going through submit. Not a test file itself (no `.test.`).

import { writePendingWrapUpJson } from '@/lib/sessions';
import { applyWrapUp, type WrapUpActor, type WrapUpProposal } from '@/lib/wrap-up';

type Applied = Extract<Awaited<ReturnType<typeof applyWrapUp>>, { status: 'applied' }>;

export async function applyStaged(
  opts: WrapUpActor & {
    sessionPath: string;
    proposal: WrapUpProposal;
    decisions: Parameters<typeof applyWrapUp>[0]['decisions'];
  },
): Promise<Applied> {
  const { proposal, ...rest } = opts;
  writePendingWrapUpJson(opts.groupId, opts.sessionPath, JSON.stringify(proposal));
  const outcome = await applyWrapUp({ ...rest, generatedAt: proposal.generatedAt });
  if (outcome.status !== 'applied') throw new Error(`apply refused: ${outcome.status}`);
  return outcome;
}
