/**
 * Tests for compareSemver (src/semver.js) — the shared version-comparison
 * implementation used by `nansen changelog --since` (src/cli.js) and the
 * update-notifier's `isNewer` (src/update-check.js).
 */

import { describe, it, expect } from 'vitest';
import { compareSemver } from '../semver.js';

describe('compareSemver', () => {
  it('compares full x.y.z versions numerically, not lexically', () => {
    expect(compareSemver('1.43.1', '1.43.0')).toBe(1);
    expect(compareSemver('1.43.0', '1.43.1')).toBe(-1);
    expect(compareSemver('1.43.0', '1.43.0')).toBe(0);
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1); // numeric, not string, comparison
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  it('treats a missing patch component as .0, not as always-less-than', () => {
    // Regression: comparing a real patch number against `undefined` (from a
    // "1.43"-shaped input with no third component) made every `>` check
    // false in both directions, so a version that matched on major.minor
    // always came out "less than" — even 1.43.1 vs "1.43".
    expect(compareSemver('1.43.1', '1.43')).toBe(1);
    expect(compareSemver('1.43.0', '1.43')).toBe(0);
    expect(compareSemver('1.42.9', '1.43')).toBe(-1);
  });

  it('treats a missing minor and patch component as .0.0', () => {
    expect(compareSemver('2.0.0', '2')).toBe(0);
    expect(compareSemver('2.1.0', '2')).toBe(1);
    expect(compareSemver('1.9.0', '2')).toBe(-1);
  });

  it('ignores a leading "v"', () => {
    expect(compareSemver('v1.43.1', 'v1.43.0')).toBe(1);
  });

  it('is symmetric: swapping arguments negates the result', () => {
    expect(compareSemver('1.43.1', '1.43.0')).toBe(-compareSemver('1.43.0', '1.43.1'));
    // Equal-after-normalization case: both directions must be exactly 0
    // (not +0 vs -0 — `toBe` uses Object.is, so assert each side directly
    // rather than negating one into the other).
    expect(compareSemver('1.43', '1.43.0')).toBe(0);
    expect(compareSemver('1.43.0', '1.43')).toBe(0);
  });

  it('treats both sides missing components consistently (e.g. "2" vs "2.0")', () => {
    expect(compareSemver('2', '2.0')).toBe(0);
    expect(compareSemver('2', '2.0.0')).toBe(0);
  });

  // Regression: Number("10-beta") is NaN, which `|| 0` turned into 0, so a
  // prerelease-suffixed component compared as if it were 0. The npm `latest`
  // dist-tag can carry such a version, and update-check/doctor compare it
  // with no format validation.
  it('reads the numeric core of a prerelease-suffixed component', () => {
    expect(compareSemver('1.2.10-beta', '1.2.9')).toBe(1);
    expect(compareSemver('1.2.9', '1.2.10-beta')).toBe(-1);
    expect(compareSemver('1.9.10-beta', '1.9.2')).toBe(1);
    expect(compareSemver('2.0.0-rc.1', '1.99.99')).toBe(1);
  });

  it('ranks a prerelease below the release it precedes', () => {
    expect(compareSemver('1.3.0-beta.1', '1.3.0')).toBe(-1);
    expect(compareSemver('1.3.0', '1.3.0-beta.1')).toBe(1);
  });

  // Documents a known gap, NOT desired behaviour: prerelease identity is not
  // compared, so any two prereleases of the same core read as equal. SemVer
  // §11 says beta < rc and rc.2 < rc.10. If you are reading this because you
  // implemented that precedence and this test failed, the test is what's
  // wrong — delete it.
  it('does not order two prereleases of the same core (known limitation)', () => {
    expect(compareSemver('1.3.0-beta.1', '1.3.0-rc.1')).toBe(0);
    expect(compareSemver('1.3.0-rc.2', '1.3.0-rc.10')).toBe(0);
  });

  it('ignores build metadata', () => {
    expect(compareSemver('1.2.3+build.7', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4+sha', '1.2.3')).toBe(1);
  });
});
