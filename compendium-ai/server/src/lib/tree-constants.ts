// Tiny module of tree-layer constants that are safe to import from
// client components. The main tree.ts pulls in the DB, which breaks
// the browser bundle — keep string-only values here.

export const WORLD_ROOT_PATH = '__world__';
export const WORLD_ROOT_NAME = 'World';
