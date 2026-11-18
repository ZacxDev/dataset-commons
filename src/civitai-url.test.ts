import { describe, expect, it } from 'vitest';

import {
  CIVITAI_MEDIA_HOSTS,
  CIVITAI_SITE_HOSTS,
  imageRefDisplay,
  safeCivitaiMediaUrl,
  safeCivitaiPostUrl,
} from './civitai-url.js';

describe('safeCivitaiMediaUrl', () => {
  it('accepts https on an exact Civitai media host and returns the parsed href', () => {
    expect(safeCivitaiMediaUrl('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/k/width=1200/k.jpeg')).toBe(
      'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/k/width=1200/k.jpeg',
    );
    // A proxied region's generated image (civitai ORCHESTRATOR_PROXY_HOST).
    expect(safeCivitaiMediaUrl('https://orchestration-proxy.civitai.com/v2/consumer/blobs/abc.jpeg?sig=x')).toBe(
      'https://orchestration-proxy.civitai.com/v2/consumer/blobs/abc.jpeg?sig=x',
    );
    expect(safeCivitaiMediaUrl('https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=x')).toBe(
      'https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=x',
    );
    // Upper-case host is canonicalised by the parser, so the href differs from the input.
    expect(safeCivitaiMediaUrl('https://IMAGE.civitai.com/a.jpeg')).toBe('https://image.civitai.com/a.jpeg');
  });

  it('rejects every other scheme, host shape and non-string', () => {
    for (const bad of [
      'http://image.civitai.com/a.jpeg',
      'https://image.civitai.com.evil.com/',
      'https://evil.com/?u=civitai.com/posts/1',
      'https://evil.com/image.civitai.com/a.jpeg',
      'javascript:alert(1)',
      '//evil.com',
      '//image.civitai.com/a.jpeg',
      'https://image.civitai.com@evil.com/a.jpeg',
      'https://user:pw@image.civitai.com/a.jpeg',
      'https://image.civitai.com:8443/a.jpeg',
      'https://evil.civitai.com/a.jpeg',
      'https://civitai.com/v2/consumer/blobs/abc',
      'data:image/png;base64,AAAA',
      'blob:https://image.civitai.com/1234',
      '/relative/a.jpeg',
      '',
    ]) {
      expect(safeCivitaiMediaUrl(bad), bad).toBeNull();
    }
    expect(safeCivitaiMediaUrl(undefined)).toBeNull();
    expect(safeCivitaiMediaUrl(42)).toBeNull();
  });
});

describe('safeCivitaiPostUrl', () => {
  it('accepts https://civitai.com/posts/<digits>', () => {
    expect(safeCivitaiPostUrl('https://civitai.com/posts/123')).toEqual({
      href: 'https://civitai.com/posts/123',
      postId: 123,
    });
    expect(safeCivitaiPostUrl('https://www.civitai.com/posts/77/')).toEqual({
      href: 'https://www.civitai.com/posts/77/',
      postId: 77,
    });
  });

  it('rejects a non-digit id, another host, another path and http', () => {
    for (const bad of [
      'https://civitai.com/posts/abc',
      'https://civitai.com/posts/',
      'https://civitai.com/posts/0',
      'https://civitai.com/posts/12/edit',
      'https://civitai.com/post/12',
      'https://civitai.com/images/12',
      'http://civitai.com/posts/123',
      'https://evil.com/?u=civitai.com/posts/1',
      'https://evil.com/civitai.com/posts/1',
      'https://civitai.com.evil.com/posts/1',
      'https://image.civitai.com/posts/1',
      'javascript:alert(1)//civitai.com/posts/1',
      '//civitai.com/posts/1',
    ]) {
      expect(safeCivitaiPostUrl(bad), bad).toBeNull();
    }
  });
});

describe('imageRefDisplay', () => {
  it('classifies post, image and everything else', () => {
    expect(imageRefDisplay('https://civitai.com/posts/123')).toEqual({ kind: 'post', href: 'https://civitai.com/posts/123' });
    expect(imageRefDisplay('https://image.civitai.com/a.jpeg')).toEqual({ kind: 'image', src: 'https://image.civitai.com/a.jpeg' });
    expect(imageRefDisplay('https://evil.com/?u=civitai.com/posts/1')).toEqual({ kind: 'unavailable' });
    expect(imageRefDisplay('http://image.civitai.com/a.jpeg')).toEqual({ kind: 'unavailable' });
    expect(imageRefDisplay('12345')).toEqual({ kind: 'unavailable' });
  });
});

describe('host ledger', () => {
  // Fails when the list GROWS as well as when it shrinks: widening what an
  // <img src> may load is a review decision, not a drive-by edit.
  it('is exactly the hosts civitai hands this app image and post urls on', () => {
    expect([...CIVITAI_MEDIA_HOSTS]).toEqual([
      'image.civitai.com',
      'orchestration.civitai.com',
      'orchestration-new.civitai.com',
      'orchestration-next.civitai.com',
      'orchestration-proxy.civitai.com',
    ]);
    expect([...CIVITAI_SITE_HOSTS]).toEqual(['civitai.com', 'www.civitai.com']);
  });
});
