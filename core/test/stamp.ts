// Every measurement names the exact commit and tree state it ran on; qualify.ts ignores
// records from another commit, a dirty tree, or an earlier run.
import { join } from 'node:path';
import { treeState } from '../../release/lib/git-state.ts';

const { commit, dirty_tree } = treeState(join(import.meta.dirname, '..', '..'));
export const STAMP = { commit, dirty_tree };
