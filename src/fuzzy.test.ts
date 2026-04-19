import { describe, it, expect } from 'vitest';
import { normalize, diceSimilarity, bestFuzzyMatch, scoreFuzzy } from './fuzzy';

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

describe('bestFuzzyMatch alias groups', () => {
  it('alias match inside an alias group wins', () => {
    const result = bestFuzzyMatch('I watched tenis yesterday', ['futebol|tenis|basquete'], 0.5);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('futebol|tenis|basquete');
    expect(result!.matchedWord).toBe('tenis');
    expect(result!.score).toBeGreaterThanOrEqual(0.95);
  });

  it('single-topic entry without | still matches', () => {
    const result = bestFuzzyMatch('I love tennis', ['tennis'], 0.5);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('tennis');
  });

  it('alias group with empty alias is treated as if the empty alias were not there', () => {
    // Double-pipe creates empty alias; should still match on the valid alias
    const result = bestFuzzyMatch('I love futebol', ['futebol||basquete'], 0.5);
    expect(result).not.toBeNull();
    expect(result!.topic).toBe('futebol||basquete');
    expect(result!.matchedWord).toBe('futebol');
  });

  it('returned topic is the full bank entry and matchedWord is the winning alias', () => {
    const result = bestFuzzyMatch('jogo de futebol', ['futebol|tenis'], 0.5);
    expect(result).not.toBeNull();
    // Full entry is preserved as topic
    expect(result!.topic).toBe('futebol|tenis');
    // matchedWord is the alias that matched, not the whole entry
    expect(result!.matchedWord).toBe('futebol');
  });
});

describe('scoreFuzzy', () => {
  it('returns top score even when below threshold', () => {
    const result = scoreFuzzy('something', ['futebol'], 0.9);
    // scoreFuzzy ignores threshold and returns the best score regardless
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(0.9);
  });

  it('returns null for empty bank', () => {
    expect(scoreFuzzy('hello', [], 0.5)).toBeNull();
  });

  it('returns null for empty body', () => {
    expect(scoreFuzzy('', ['tennis'], 0.5)).toBeNull();
  });

  it('agrees with bestFuzzyMatch when top score >= threshold', () => {
    const body = 'I love tennis';
    const bank = ['tennis'];
    const threshold = 0.5;
    const scored = scoreFuzzy(body, bank, threshold);
    const best = bestFuzzyMatch(body, bank, threshold);
    expect(scored).not.toBeNull();
    expect(best).not.toBeNull();
    expect(scored!.topic).toBe(best!.topic);
    expect(scored!.matchedWord).toBe(best!.matchedWord);
    expect(scored!.score).toBeCloseTo(best!.score, 5);
  });
});
