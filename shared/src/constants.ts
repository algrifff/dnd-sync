// Protocol-level constants shared between server and plugin.

export const WS_PATH = '/sync' as const;

export const MARKDOWN_EXTENSIONS = ['.md', '.canvas'] as const;
export const BINARY_EXTENSIONS = [
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.heic',
  '.heif',
  '.tiff',
  '.ico',
  '.avif',
  // video
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.m4v',
  // audio
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.aac',
  // documents
  '.pdf',
] as const;

export type MarkdownExtension = (typeof MARKDOWN_EXTENSIONS)[number];
export type BinaryExtension = (typeof BINARY_EXTENSIONS)[number];
