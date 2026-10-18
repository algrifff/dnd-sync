/** The app URL of a Note in the current World. */
export function noteHref(path: string): string {
  return `/notes/${path.split('/').map(encodeURIComponent).join('/')}`;
}
