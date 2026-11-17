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
 * sends, plus `share: true`, and reads the host's `shared` echo. The two casts
 * below are those two fields. Replace
 * this module with `useImageUpload({ share: true })` (which resolves with the
 * same `shared` echo) once the SDK release that
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

/**
 * The uploaded image, plus whether sharing TOOK EFFECT: the host echoes
 * `shared: true` only when the server recorded the upload as shared. A host
 * without the echo (one that predates sharing, and ignored `share`) reads as
 * `false`: the upload is then private to the uploader.
 */
export type SharedUploadResult = BlockUploadedImageInfo & { shared: boolean };

/** `open()` resolves with the moderated image, `null` when the viewer dismissed, and rejects when the host refused. */
export function useSharedImageUpload(): { open: () => Promise<SharedUploadResult | null> } {
  const open = useCallback(async () => {
    const reply = await sendTypedRequest(getTransport(), sharedUploadRequest(), 'IMAGE_UPLOAD_RESULT', {
      timeoutMs: SHARED_UPLOAD_TIMEOUT_MS,
    });
    // A refused shared upload (e.g. the host has no block token) is an error, never a
    // dismissed picker: the Upload tab tells the viewer the image is shared.
    if (typeof reply.error === 'string' && reply.error.length > 0) throw new Error(reply.error);
    const { selected } = reply;
    // The second (and last) cast: `shared` is not in the published IMAGE_UPLOAD_RESULT type yet.
    const shared = (reply as { shared?: unknown }).shared === true;
    // A multi-image training reply, or a shape without an image id, is not an answer to this upload.
    if (!selected || 'images' in selected || !('imageId' in selected)) return null;
    return { ...(selected as BlockUploadedImageInfo), shared };
  }, []);
  return { open };
}
