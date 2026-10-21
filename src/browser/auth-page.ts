/**
 * Helpers for driving the FreeTaxUSA sign-in site (auth.freetaxusa.com).
 *
 * The sign-in site is a single-page app. Selectors here come from the live page
 * and from the agent tooling FreeTaxUSA ships in that app, so they track what
 * the site itself treats as stable.
 */

import { type Page } from 'playwright';

const AUTH_HOST = 'auth.freetaxusa.com';

export const SIGN_IN = {
  username: '#username',
  password: '#password',
  // The form also holds a hidden, unlabeled submit button ahead of this one.
  submit: 'button.sign-in[type="submit"]',
} as const;

export const VERIFICATION = {
  code: '#twoFactorCode',
  rememberDevice: '#rememberMe',
  submit: 'button[type="submit"][form="verificationForm"]',
  phoneOption: 'input[name="selectContactInfo"]',
} as const;

export const VERIFICATION_METHODS = ['text', 'voice_call', 'email', 'authenticator_app'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

const METHOD_OPTION: Record<VerificationMethod, string> = {
  authenticator_app: '#totpOption',
  email: '#emailOption',
  text: '#textOption',
  voice_call: '#voiceOption',
};

export type AuthStep =
  | { kind: 'signed_in' }
  | { kind: 'sign_in' }
  | { kind: 'choose_verification_method' }
  | { kind: 'verification_code'; method: 'phone' | 'email' | 'authenticator_app' | 'emergency_code' }
  | { kind: 'passkey_offer' }
  | { kind: 'account_step'; name: string }
  | { kind: 'browser_not_supported' }
  | { kind: 'unknown'; path: string };

const CODE_PAGES: Record<string, Extract<AuthStep, { kind: 'verification_code' }>['method']> = {
  '/textverification': 'phone',
  '/emailverification': 'email',
  '/authappverification': 'authenticator_app',
  '/emergencycodeverification': 'emergency_code',
};

/** Required account changes the site can insert after the password is accepted. */
const ACCOUNT_STEPS: Record<string, string> = {
  '/update-password': 'update_password',
  '/choose-username': 'choose_username',
  '/verify-sms': 'verify_phone',
  '/confirmemail': 'confirm_email',
};

/** Work out which sign-in step a URL shows. */
export function classifyAuthUrl(url: string): AuthStep {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown', path: url };
  }
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';

  if (parsed.hostname !== AUTH_HOST) {
    // Signed-out requests to the tax app redirect to the sign-in site, so landing here means signed in.
    if (parsed.hostname.endsWith('freetaxusa.com') && path.startsWith('/taxes')) return { kind: 'signed_in' };
    return { kind: 'unknown', path: parsed.pathname };
  }

  if (path === '/' || path === '/login-sso' || path === '/preparer/login') return { kind: 'sign_in' };
  if (path === '/verifywithtwostepmethod') return { kind: 'choose_verification_method' };
  if (CODE_PAGES[path]) return { kind: 'verification_code', method: CODE_PAGES[path] };
  if (path === '/passkey-upsell') return { kind: 'passkey_offer' };
  if (ACCOUNT_STEPS[path]) return { kind: 'account_step', name: ACCOUNT_STEPS[path] };
  if (path === '/browser-entry-denied') return { kind: 'browser_not_supported' };
  return { kind: 'unknown', path: parsed.pathname };
}

/** Steps that sit between a submitted password and the tax return. */
export function isMidSignIn(step: AuthStep): boolean {
  return (
    step.kind === 'choose_verification_method' ||
    step.kind === 'verification_code' ||
    step.kind === 'passkey_offer' ||
    step.kind === 'account_step'
  );
}

/** True while the hCaptcha image puzzle is showing (the checkbox widget is zero-width and ignored). */
export async function isCaptchaShowing(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="hcaptcha"]')].some(
        f => /challenge/i.test(f.title ?? '') && f.getBoundingClientRect().width > 0 && getComputedStyle(f).visibility !== 'hidden',
      ),
    )
    .catch(() => false);
}

export interface AuthAlert {
  type: 'error' | 'warning' | 'info' | 'success';
  text: string;
}

/** Read the visible toast alerts the sign-in site uses for errors such as a wrong password or code. */
export async function readAlerts(page: Page): Promise<AuthAlert[]> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#toastAlertArea .alert-message')]
        .filter(e => e.getClientRects().length > 0)
        .map(e => {
          const content = e.querySelector<HTMLElement>('.toast-alert-content') ?? e;
          const type = (['error', 'warning', 'info', 'success'] as const).find(t => e.classList.contains(`${t}-message`)) ?? 'info';
          return { type, text: content.innerText.replace(/\s+/g, ' ').trim() };
        })
        .filter(a => a.text),
    )
    .catch(() => []);
}

async function isLoading(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const e = document.getElementById('loadingScreen');
      return Boolean(e && !e.classList.contains('d-none'));
    })
    .catch(() => false);
}

function buttonByText(page: Page, text: string) {
  return page
    .locator('#mainContentArea')
    .locator('button:visible, a:visible')
    .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`, 'i') })
    .first();
}

/** Click an input the way a person would, so the app's own change handlers run. */
async function setChecked(page: Page, selector: string, checked: boolean): Promise<void> {
  await page.locator(selector).first().evaluate((el, want) => {
    const input = el as HTMLInputElement;
    if (input.checked !== want) input.click();
  }, checked);
}

export async function submitCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.locator(SIGN_IN.username).fill(username);
  await page.locator(SIGN_IN.password).fill(password);
  await page.locator(SIGN_IN.submit).click();
}

/** Methods offered on the "choose how to get your code" page. */
export async function availableVerificationMethods(page: Page): Promise<VerificationMethod[]> {
  const offered: VerificationMethod[] = [];
  for (const method of VERIFICATION_METHODS) {
    if ((await page.locator(METHOD_OPTION[method]).count()) > 0) offered.push(method);
  }
  return offered;
}

/** Masked phone numbers offered when the account has more than one. */
export async function availablePhones(page: Page): Promise<string[]> {
  return page
    .locator(VERIFICATION.phoneOption)
    .evaluateAll(els =>
      els
        .filter(e => !e.closest('.d-none'))
        .map(e => ((e as HTMLInputElement).labels?.[0]?.innerText ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    )
    .catch(() => []);
}

/**
 * Pick how the code is sent and press Continue.
 * Returns the phones to choose from when several exist and `phone` is missing or doesn't match.
 */
export async function chooseVerificationMethod(
  page: Page,
  method: VerificationMethod,
  phone?: string,
): Promise<{ phoneNeeded: string[] } | null> {
  const option = METHOD_OPTION[method];
  if ((await page.locator(option).count()) === 0) {
    throw new Error(`"${method}" is not offered for this account. Offered: ${(await availableVerificationMethods(page)).join(', ')}`);
  }
  await setChecked(page, option, true);

  if (method === 'text' || method === 'voice_call') {
    const phones = await availablePhones(page);
    if (phones.length > 1) {
      const wanted = (phone ?? '').trim().toLowerCase();
      const digits = wanted.replace(/\D/g, '');
      const index = phones.findIndex(
        p => p.toLowerCase() === wanted || (digits.length >= 2 && p.replace(/\D/g, '').endsWith(digits)),
      );
      if (index < 0) return { phoneNeeded: phones };
      await page.locator(VERIFICATION.phoneOption).nth(index).evaluate(el => (el as HTMLInputElement).click());
    }
  }

  await buttonByText(page, 'Continue').click();
  return null;
}

export async function submitVerificationCode(page: Page, code: string, rememberDevice?: boolean): Promise<void> {
  await page.locator(VERIFICATION.code).fill(code);
  if (typeof rememberDevice === 'boolean' && (await page.locator(VERIFICATION.rememberDevice).count()) > 0) {
    await setChecked(page, VERIFICATION.rememberDevice, rememberDevice);
  }
  await page.locator(VERIFICATION.submit).click();
}

/** Decline the passkey offer, as the page's "Not Now" button does. Nothing on the account changes. */
export async function declinePasskeyOffer(page: Page): Promise<void> {
  await buttonByText(page, 'Not Now').click();
}

export type AuthOutcome =
  | { kind: 'step'; step: AuthStep }
  | { kind: 'captcha' }
  | { kind: 'rejected'; alerts: AuthAlert[] }
  | { kind: 'timeout'; step: AuthStep; alerts: AuthAlert[]; captcha: boolean };

export interface WaitOptions {
  /**
   * 'agent': return as soon as the page moves to another step, shows a new error, or shows a captcha.
   * 'person': the person is driving the browser; return only once signed in (or on timeout).
   */
  mode: 'agent' | 'person';
  /** How long to wait for the page to move on. */
  timeoutMs: number;
  /** In agent mode with a visible browser: how long to give the person to solve a captcha. 0 reports it at once. */
  captchaTimeoutMs?: number;
  /** Alert texts already showing before the action, so they aren't mistaken for its result. */
  ignoreAlerts?: string[];
  /** URL before the action. Defaults to the current URL, which misses a page that already moved on. */
  fromUrl?: string;
}

/** Wait for the sign-in site to settle after an action and report where it ended up. */
export async function waitForAuthOutcome(page: Page, opts: WaitOptions): Promise<AuthOutcome> {
  const startUrl = opts.fromUrl ?? page.url();
  const ignore = new Set(opts.ignoreAlerts ?? []);
  let deadline = Date.now() + opts.timeoutMs;
  let captchaExtended = false;

  for (;;) {
    const url = page.url();
    const step = classifyAuthUrl(url);
    if (step.kind === 'signed_in') return { kind: 'step', step };

    if (opts.mode === 'agent') {
      // The site keeps its loading screen up while the captcha puzzle shows, so check the captcha first.
      if (await isCaptchaShowing(page)) {
        const captchaTimeoutMs = opts.captchaTimeoutMs ?? 0;
        if (captchaTimeoutMs <= 0) return { kind: 'captcha' };
        if (!captchaExtended) {
          deadline = Math.max(deadline, Date.now() + captchaTimeoutMs);
          captchaExtended = true;
        }
      } else if (!(await isLoading(page))) {
        if (url !== startUrl && step.kind !== 'sign_in') return { kind: 'step', step };

        const errors = (await readAlerts(page)).filter(a => (a.type === 'error' || a.type === 'warning') && !ignore.has(a.text));
        if (errors.length) return { kind: 'rejected', alerts: errors };
      }
    }

    if (Date.now() >= deadline) {
      return { kind: 'timeout', step, alerts: await readAlerts(page), captcha: await isCaptchaShowing(page) };
    }
    await page.waitForTimeout(500);
  }
}
