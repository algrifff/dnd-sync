// Protocol-level constants shared between server and plugin.

export const WS_PATH = '/sync' as const;

export const MARKDOWN_EXTENSIONS = ['.md', '.canvas'] as const;
export const BINARY_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.mp3',
  '.mp4',
  '.webm',
] as const;

export type MarkdownExtension = (typeof MARKDOWN_EXTENSIONS)[number];
export type BinaryExtension = (typeof BINARY_EXTENSIONS)[number];
