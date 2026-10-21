import { describe, it, expect } from 'vitest';
import { resolveTaxYear, latestTaxYear, MIN_TAX_YEAR } from '../../src/config.js';

const OCT_2026 = new Date('2026-10-21T12:00:00Z');

describe('resolveTaxYear', () => {
  it('defaults to 2025', () => {
    expect(resolveTaxYear(undefined, OCT_2026)).toBe('2025');
  });

  it('accepts every offered year', () => {
    expect(resolveTaxYear('2018', OCT_2026)).toBe('2018');
    expect(resolveTaxYear('2023', OCT_2026)).toBe('2023');
    expect(resolveTaxYear(' 2024 ', OCT_2026)).toBe('2024');
    expect(resolveTaxYear('2025', OCT_2026)).toBe('2025');
  });

  it('rejects years before FreeTaxUSA offers them', () => {
    expect(() => resolveTaxYear('2017', OCT_2026)).toThrow(/2018-2025/);
  });

  it('rejects a tax year that has not opened yet', () => {
    expect(() => resolveTaxYear('2026', OCT_2026)).toThrow(/2018-2025/);
    expect(resolveTaxYear('2026', new Date('2027-01-15T12:00:00Z'))).toBe('2026');
  });

  it('rejects malformed values', () => {
    expect(() => resolveTaxYear('', OCT_2026)).toThrow(/four-digit/);
    expect(() => resolveTaxYear('25', OCT_2026)).toThrow(/four-digit/);
    expect(() => resolveTaxYear('2025a', OCT_2026)).toThrow(/four-digit/);
  });
});

describe('latestTaxYear', () => {
  it('is the previous calendar year', () => {
    expect(latestTaxYear(OCT_2026)).toBe(2025);
    expect(MIN_TAX_YEAR).toBe(2018);
  });
});
