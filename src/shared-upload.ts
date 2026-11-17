/**
 * Dataset Commons — the Upload tab's image upload, SHARED with this dataset's
 * viewers once Civitai has scanned it.
 *
 * A viewer-picked upload is private to the uploader unless the app asks the
 * host to share it: `OPEN_IMAGE_UPLOAD { share: true }`. The host then tells
 * the viewer in its upload dialog, before they pick a file, that the image will
 * be visible to the app's other viewers once scanned, and the server records
 * this app (from the verified block token) on the image. The app's gated image
 * read returns it to other viewers once it is scanned (`./item-images.ts`).
 *
 * 🔴 TEMPORARY: the published `@civitai/blocks-react` 0.83 `useImageUpload()`
 * cannot send `share` (its options have none, and it builds the payload
 * itself), so this sends the same message the hook's blocking display path
 * sends, plus `share: true`. The one cast below is that extra field. Replace
 * this module with `useImageUpload({ share: true })` once the SDK release that
 * adds the option is published, and bump the dependency.
 */

import { useCallback } from 'react';

import { getTransport, sendTypedRequest, type OutboundRequest } from '@civitai/blocks-react';
import type { BlockUploadedImageInfo } from '@civitai/app-sdk/blocks';

/** The hook's own bound for a human-interactive upload (blocks-react `HUMAN_INTERACTION_TIMEOUT_MS`). */
export const SHARED_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** The message the Upload tab sends: a display upload with `share: true`. */
export function sharedUploadRequest(): OutboundRequest {
  // The only cast: `share` is not in the published OPEN_IMAGE_UPLOAD payload type yet.
  return { type: 'OPEN_IMAGE_UPLOAD', payload: { share: true } } as unknown as OutboundRequest;
}

/** `open()` resolves with the moderated image, or `null` when the viewer dismissed. */
export function useSharedImageUpload(): { open: () => Promise<BlockUploadedImageInfo | null> } {
  const open = useCallback(async () => {
    const { selected } = await sendTypedRequest(getTransport(), sharedUploadRequest(), 'IMAGE_UPLOAD_RESULT', {
      timeoutMs: SHARED_UPLOAD_TIMEOUT_MS,
    });
    // A multi-image training reply, or a shape without an image id, is not an answer to this upload.
    if (!selected || 'images' in selected || !('imageId' in selected)) return null;
    return selected as BlockUploadedImageInfo;
  }, []);
  return { open };
}
