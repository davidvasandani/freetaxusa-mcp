/**
 * Server configuration read from the environment.
 */

/** Earliest tax year FreeTaxUSA's sign-in site offers. Older years are shown as 2018. */
export const MIN_TAX_YEAR = 2018;

/**
 * Latest tax year that can be open for filing: tax year Y opens in January of Y+1.
 * The sign-in page accepts later years without complaint, so this is checked here.
 */
export function latestTaxYear(now: Date = new Date()): number {
  return now.getFullYear() - 1;
}

/**
 * Validate FREETAXUSA_TAX_YEAR, defaulting to 2025.
 * Throws with a readable message when the year is malformed or outside the offered range.
 */
export function resolveTaxYear(raw: string | undefined, now: Date = new Date()): string {
  const value = (raw ?? '2025').trim();
  if (!/^\d{4}$/.test(value)) {
    throw new Error(`FREETAXUSA_TAX_YEAR must be a four-digit year, got "${raw}".`);
  }
  const year = Number(value);
  const max = latestTaxYear(now);
  if (year < MIN_TAX_YEAR || year > max) {
    throw new Error(
      `FREETAXUSA_TAX_YEAR=${year} is outside the tax years FreeTaxUSA offers (${MIN_TAX_YEAR}-${max}).`,
    );
  }
  return value;
}
