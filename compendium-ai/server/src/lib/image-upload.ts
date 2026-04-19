// Client-side helper for uploading an image to /api/assets/upload and
// returning the fields we need to insert an embed node at the cursor.
// Shared between the slash command and the drag-drop handler so
// both code paths agree on error shape, size caps, and mime checks.

const IMAGE_MIME_PREFIX = 'image/';

export type UploadedAsset = {
  id: string;
  mime: string;
  size: number;
  originalName: string;
};

export async function uploadImageAsset(
  file: File,
  csrfToken: string,
): Promise<UploadedAsset> {
  if (!file.type.startsWith(IMAGE_MIME_PREFIX)) {
    throw new Error(`not an image (${file.type || 'unknown mime'})`);
  }

  const fd = new FormData();
  fd.set('file', file);

  const res = await fetch('/api/assets/upload', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    body: fd,
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    id?: string;
    mime?: string;
    size?: number;
    originalName?: string;
    error?: string;
    message?: string;
  };

  if (!res.ok || !body.ok || !body.id) {
    throw new Error(body.message ?? body.error ?? `upload failed (HTTP ${res.status})`);
  }

  return {
    id: body.id,
    mime: body.mime ?? file.type,
    size: body.size ?? file.size,
    originalName: body.originalName ?? file.name,
  };
}

/** Return every image File in a DataTransfer, skipping non-image drops
 *  (plain text, URLs, etc.). */
export function imageFilesFromDataTransfer(dt: DataTransfer): File[] {
  const out: File[] = [];
  for (const f of Array.from(dt.files)) {
    if (f.type.startsWith(IMAGE_MIME_PREFIX)) out.push(f);
  }
  return out;
}
