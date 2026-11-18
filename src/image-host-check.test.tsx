import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import {
  datasetDoc,
  isPostReference,
  itemDoc,
  parseImageReference,
  validateContribution,
  type DatasetItemRecord,
  type DatasetRecord,
} from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { saveTargetForItem } from './item-images.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';

// A shared `items` document is written by any contributor, and a client can
// write one straight to the store, skipping this app's form. These pin what
// the app does with a hostile stored `imageRef`, through the consumers that
// put it in `src` / `href` / a save, and what the app itself will write.
// Inputs are literal; none is derived from the host list in ./civitai-url.ts.

const MEDIA_OK = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/0a1b2c3d/width=1200/0a1b2c3d.jpeg';
const POST_OK = 'https://civitai.com/posts/123';

/** Every ref here must never reach an `<img src>`, an `<a href>` or a save-by-url. */
const HOSTILE: Record<string, string> = {
  http: 'http://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/0a1b2c3d/width=1200/0a1b2c3d.jpeg',
  suffix: 'https://image.civitai.com.evil.com/',
  query: 'https://evil.com/?u=civitai.com/posts/1',
  js: 'javascript:alert(1)',
  protocolRelative: '//evil.com',
  postNotDigits: 'https://civitai.com/posts/abc',
  pathMention: 'https://evil.com/civitai.com/posts/1',
  userinfo: 'https://image.civitai.com@evil.com/x.jpeg',
};

describe('what the app will WRITE as an imageRef', () => {
  it('accepts a Civitai media url and a Civitai post url', () => {
    expect(validateContribution({ imageRef: MEDIA_OK, caption: 'c', rightsAsserted: true }).ok).toBe(true);
    expect(validateContribution({ imageRef: POST_OK, caption: 'c', rightsAsserted: true }).ok).toBe(true);
    expect(parseImageReference(POST_OK)).toEqual({ ok: true, value: { postId: 123, imageRef: POST_OK } });
    expect(parseImageReference(MEDIA_OK)).toEqual({ ok: true, value: { imageRef: MEDIA_OK } });
  });

  for (const [name, ref] of Object.entries(HOSTILE)) {
    it(`refuses to save the ${name} ref ${ref}`, () => {
      expect(validateContribution({ imageRef: ref, caption: 'c', rightsAsserted: true }).ok).toBe(false);
      expect(parseImageReference(ref).ok).toBe(false);
    });
  }
});

describe('isPostReference parses the host and path', () => {
  it('is true only for https://civitai.com/posts/<digits>', () => {
    expect(isPostReference(POST_OK)).toBe(true);
    expect(isPostReference('https://civitai.com/posts/abc')).toBe(false);
    expect(isPostReference('https://evil.com/?u=civitai.com/posts/1')).toBe(false);
    expect(isPostReference('https://evil.com/civitai.com/posts/1')).toBe(false);
    expect(isPostReference('http://civitai.com/posts/123')).toBe(false);
  });
});

describe('saving an item by its stored url', () => {
  it('saves a Civitai media url and offers no save for a hostile one', () => {
    expect(saveTargetForItem({ imageUrl: MEDIA_OK }, new Map())).toEqual({ url: MEDIA_OK });
    for (const ref of Object.values(HOSTILE)) {
      expect(saveTargetForItem({ imageUrl: ref }, new Map())).toBeNull();
    }
  });
});

describe('rendering a stored imageRef', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  const dataset: DatasetRecord = {
    datasetId: 'ds-hostile',
    ownerId: 7,
    ownerName: 'archivist',
    name: 'Hostile Refs',
    description: '',
    targetNote: '',
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
  };
  const item = (itemId: string, imageRef: string): DatasetItemRecord => ({
    itemId,
    datasetId: dataset.datasetId,
    contributorId: 11,
    contributorName: 'mallory',
    imageRef,
    caption: `caption ${itemId}`,
    rightsAsserted: true,
    createdAt: '2026-11-18T01:00:00.000Z',
    updatedAt: '2026-11-18T01:00:00.000Z',
  });

  it('puts no hostile ref in an <img src> or <a href>, and still renders the Civitai ones', async () => {
    const user = userEvent.setup();
    // Written straight to the store, the way a client that skips the form would.
    await seedCommunity(testDocStore(), [
      { collection: 'datasets', author: 'archivist', data: datasetDoc(dataset) },
      { collection: 'items', author: 'mallory', data: itemDoc(item('media-ok', MEDIA_OK)) },
      { collection: 'items', author: 'mallory', data: itemDoc(item('post-ok', POST_OK)) },
      ...Object.entries(HOSTILE).map(([name, ref]) => ({
        collection: 'items' as const,
        author: 'mallory',
        data: itemDoc(item(`bad-${name}`, ref)),
      })),
    ]);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await screen.findByTestId('dc-community');
    await user.click(await screen.findByTestId('dc-open-dataset-ds-hostile', {}, { timeout: 5000 }));
    await screen.findByTestId('dc-item-card-bad-http', {}, { timeout: 5000 });

    // Positive controls: the selectors below do find a Civitai image and post link.
    const mediaCard = screen.getByTestId('dc-item-card-media-ok');
    expect(mediaCard.querySelector('img')?.getAttribute('src')).toBe(MEDIA_OK);
    const postCard = screen.getByTestId('dc-item-card-post-ok');
    expect(postCard.querySelector('a')?.getAttribute('href')).toBe(POST_OK);

    for (const name of Object.keys(HOSTILE)) {
      const card = screen.getByTestId(`dc-item-card-bad-${name}`);
      expect(card.querySelector('img'), `${name}: <img>`).toBeNull();
      expect(card.querySelector('a[href]'), `${name}: <a href>`).toBeNull();
      expect(card).toHaveTextContent('Image unavailable');
    }

    // And nowhere on the page does any hostile ref reach a src or href.
    const hostileValues = new Set(Object.values(HOSTILE));
    const carriers = [...document.querySelectorAll('[src], [href]')].filter((el) =>
      hostileValues.has(el.getAttribute('src') ?? el.getAttribute('href') ?? ''),
    );
    expect(carriers).toEqual([]);
  }, 20000);
});
