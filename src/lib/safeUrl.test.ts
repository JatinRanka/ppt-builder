/**
 * SSRF guard tests.
 *
 * Each blocked case here was verified to be ACCEPTED before safeUrl.ts existed:
 * the deck arrives in the request body, so `block.url` is attacker-controlled,
 * and the exporter fetched it server-side with redirects followed.
 */
import { describe, expect, it } from 'vitest';
import { isAllowedImageUrl, isSafeImageUrlScheme } from './safeUrl';

describe('isAllowedImageUrl', () => {
  it('allows the unsplash hosts the app actually generates', () => {
    expect(isAllowedImageUrl('https://images.unsplash.com/photo-1451187580459')).toBe(true);
    expect(isAllowedImageUrl('https://source.unsplash.com/featured/1600x900/?city')).toBe(true);
    expect(isAllowedImageUrl('https://plus.unsplash.com/premium_photo-1')).toBe(true);
  });

  it('blocks cloud metadata endpoints', () => {
    // The payoff case: on AWS this returns IAM role credentials.
    expect(isAllowedImageUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/')).toBe(false);
    expect(isAllowedImageUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedImageUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(false);
  });

  it('blocks loopback and private ranges', () => {
    for (const u of [
      'http://localhost:6379/',
      'https://localhost/',
      'http://127.0.0.1:22',
      'https://10.0.0.5/admin',
      'https://192.168.1.1/',
      'https://172.16.0.1/',
      'http://[::1]:8080/admin',
      'https://0.0.0.0/',
    ]) {
      expect(isAllowedImageUrl(u), u).toBe(false);
    }
  });

  it('blocks non-https schemes, including file: and data:', () => {
    for (const u of [
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'gopher://example.com/_x',
      'ftp://images.unsplash.com/x.png',
      // plain http, even on an allowlisted host: redirectable in transit
      'http://images.unsplash.com/photo-1',
    ]) {
      expect(isAllowedImageUrl(u), u).toBe(false);
    }
  });

  it('is not fooled by an allowlisted host appearing elsewhere in the url', () => {
    // Classic allowlist bypasses: userinfo, subdomain suffix, path, query.
    for (const u of [
      'https://images.unsplash.com@169.254.169.254/',
      'https://images.unsplash.com.evil.test/photo',
      'https://evil.test/images.unsplash.com/photo',
      'https://evil.test/?x=images.unsplash.com',
      'https://user:pass@images.unsplash.com/photo',
    ]) {
      expect(isAllowedImageUrl(u), u).toBe(false);
    }
  });

  it('allows genuine subdomains of an allowlisted host', () => {
    expect(isAllowedImageUrl('https://cdn.images.unsplash.com/photo-1')).toBe(true);
  });

  it('rejects unparseable input rather than throwing', () => {
    expect(isAllowedImageUrl('')).toBe(false);
    expect(isAllowedImageUrl('not a url')).toBe(false);
    expect(isAllowedImageUrl('///')).toBe(false);
  });
});

describe('isSafeImageUrlScheme', () => {
  it('keeps javascript: and data: out of a stored deck', () => {
    expect(isSafeImageUrlScheme('javascript:alert(1)')).toBe(false);
    expect(isSafeImageUrlScheme('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeImageUrlScheme('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeImageUrlScheme('vbscript:msgbox(1)')).toBe(false);
  });

  it('permits http(s) so the client can still render third-party images', () => {
    expect(isSafeImageUrlScheme('https://example.test/a.png')).toBe(true);
    expect(isSafeImageUrlScheme('http://example.test/a.png')).toBe(true);
  });
});
