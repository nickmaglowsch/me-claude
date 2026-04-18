import { describe, it, expect } from 'vitest';
import { normalize, diceSimilarity, bestFuzzyMatch } from './fuzzy';

describe('normalize', () => {
  it('lowercases', () => {
    expect(normalize('TENNIS')).toBe('tennis');
  });

  it('strips basic latin diacritics', () => {
    expect(normalize('café')).toBe('cafe');
    expect(normalize('ação')).toBe('acao');
  });

  it('strips punctuation', () => {
    expect(normalize('tennis!')).toBe('tennis');
  });

  it('collapses whitespace', () => {
    expect(normalize('  hello   world  ')).toBe('hello world');
  });
});

describe('diceSimilarity', () => {
  it('identical strings → 1.0', () => {
    expect(diceSimilarity('tennis', 'tennis')).toBe(1.0);
  });

  it('completely disjoint → close to 0', () => {
    expect(diceSimilarity('tennis', 'xyz')).toBeLessThan(0.1);
  });

  it('similar strings → > 0.7', () => {
    expect(diceSimilarity('tennis', 'tenis')).toBeGreaterThan(0.7);
  });

  it('is case insensitive through normalize', () => {
    expect(diceSimilarity('Tennis', 'TENIS')).toBeGreaterThan(0.7);
  });
});

describe('bestFuzzyMatch', () => {
  it('returns top match when word in body matches bank entry', () => {
    const result = bestFuzzyMatch('I watched tennis yesterday', ['tennis', 'cooking'], 0.5);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('tennis');
    expect(result!.score).toBeGreaterThan(0.9);
  });

  it('respects threshold — returns null when best score is below threshold', () => {
    const result = bestFuzzyMatch('hello world', ['xyz'], 0.5);
    expect(result).toBeNull();
  });

  it('empty bank → returns null', () => {
    const result = bestFuzzyMatch('anything', [], 0.5);
    expect(result).toBeNull();
  });

  it('empty body → returns null', () => {
    const result = bestFuzzyMatch('', ['x'], 0.5);
    expect(result).toBeNull();
  });

  it('fuzzy matches across small typo', () => {
    const result = bestFuzzyMatch('I played tenis', ['tennis'], 0.7);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('tennis');
  });

  it('threshold 0.0 always returns the best match', () => {
    const result = bestFuzzyMatch('hello world', ['xyz'], 0.0);
    expect(result).not.toBeNull();
  });

  it('returns matchedWord field', () => {
    const result = bestFuzzyMatch('I watched tennis yesterday', ['tennis'], 0.5);
    expect(result).not.toBeNull();
    expect(typeof result!.matchedWord).toBe('string');
  });
});
