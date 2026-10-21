/**
 * Session tools: authenticate, get_session_status
 */

import { z } from 'zod';
import { type Page } from 'playwright';
import {
  getPage,
  isSessionExpired,
  isHeadless,
  extractSidFromUrl,
  AUTH_URL,
  BASE_URL,
  TAX_YEAR,
  acquirePageLock,
  seedSessionFromHermes,
} from '../browser/context.js';
import {
  SIGN_IN,
  VERIFICATION_METHODS,
  classifyAuthUrl,
  isMidSignIn,
  isCaptchaShowing,
  readAlerts,
  submitCredentials,
  availableVerificationMethods,
  availablePhones,
  chooseVerificationMethod,
  submitVerificationCode,
  declinePasskeyOffer,
  waitForAuthOutcome,
  type AuthOutcome,
  type AuthStep,
  type AuthAlert,
  type WaitOptions,
} from '../browser/auth-page.js';
import { discoverSidMap, waitForPageReady } from '../browser/navigation.js';
import { filterPII } from '../security/pii-filter.js';
import type { SessionStatus } from '../types/tax.js';
import { getPageTitle } from '../browser/forms.js';

/** How long one call waits for a person (captcha, interactive sign-in) by default. Kept under common 60s client timeouts. */
const DEFAULT_WAIT_SECONDS = 40;
/** How long to wait for the sign-in site to respond to a submitted form. */
const STEP_TIMEOUT_MS = 20_000;

export const authenticateSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('FreeTaxUSA username. The sign-in page asks for a username, which may or may not be an email address. Not needed when Hermes brokers the login, for interactive sign-in, or when continuing two-step verification.'),
  email: z.string().min(1).max(128).optional().describe('Deprecated alias for username.'),
  password: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('FreeTaxUSA password. Not needed when Hermes brokers the login, for interactive sign-in, or when continuing two-step verification.'),
  mfaCode: z
    .string()
    .min(1)
    .optional()
    .describe('Two-step verification code, after a call returned mfaRequired with step "verification_code". Sign-in continues from the code page; it does not start over.'),
  verificationMethod: z
    .enum(VERIFICATION_METHODS)
    .optional()
    .describe('How to receive the two-step code, after a call returned step "choose_verification_method".'),
  phone: z
    .string()
    .optional()
    .describe('Masked phone number exactly as listed (e.g. "(***) ***-1234"), when several are offered for text or voice_call.'),
  rememberDevice: z.boolean().optional().describe('With mfaCode: whether FreeTaxUSA should remember this browser and skip two-step verification next time.'),
  interactive: z
    .boolean()
    .optional()
    .describe('Open the sign-in page in the visible browser and wait while the person signs in themselves (password, captcha, two-step code). Needs FREETAXUSA_HEADLESS=false. Call again with interactive: true to keep waiting.'),
  waitSeconds: z
    .number()
    .int()
    .min(5)
    .max(600)
    .optional()
    .describe(`How long this call waits for the person to solve a captcha or finish an interactive sign-in. Default ${DEFAULT_WAIT_SECONDS}.`),
});

type AuthenticateInput = z.infer<typeof authenticateSchema>;
type LoginOutcome = AuthOutcome | { kind: 'phone_needed'; phones: string[] };
type AuthSource = 'embedded' | 'interactive';

export async function authenticate(input: AuthenticateInput): Promise<Record<string, unknown>> {
  const release = await acquirePageLock();
  try {
    const page = await getPage();

    // Hermes is the AUTHORITATIVE auth path when configured. Try it before any
    // embedded Playwright login. If it seeds a session, verify it landed and
    // return — no email/password needed. If Hermes is not configured (or is
    // configured-but-down with FREETAXUSA_LEGACY_AUTH=true), fall through to the
    // embedded login below. If configured-but-down without the legacy flag,
    // seedSessionFromHermes() throws (fail loud).
    const hermesOutcome = await seedSessionFromHermes();
    if (hermesOutcome === 'seeded') {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {});
      await waitForPageReady(page);
      const landedUrl = page.url();
      const hermesAuthenticated = landedUrl.includes('freetaxusa.com') && !landedUrl.includes('auth.freetaxusa.com');

      if (hermesAuthenticated) {
        await discoverSidMap(page);
        return filterPII({
          authenticated: true,
          authSource: 'hermes',
          taxYear: TAX_YEAR,
          currentUrl: landedUrl,
          message: 'Authenticated via Hermes-brokered session.',
        });
      }

      // Cookies were injected but the site still bounced us to login — the
      // brokered session is stale/invalid. Do NOT silently retry with embedded
      // login: that defeats Hermes ownership. Surface it so the operator
      // refreshes the Hermes-side credential.
      return filterPII({
        authenticated: false,
        authSource: 'hermes',
        taxYear: TAX_YEAR,
        currentUrl: landedUrl,
        message:
          'Hermes provided a session but FreeTaxUSA still requires login (stale/invalid brokered cookies). ' +
          'Refresh the freetaxusa cookie-session credential in Hermes. ' +
          '(Set FREETAXUSA_LEGACY_AUTH=true to allow the embedded Playwright login fallback.)',
      });
    }

    // Embedded login path: Hermes not configured, or configured-but-down
    // with FREETAXUSA_LEGACY_AUTH=true.
    return filterPII(await embeddedLogin(page, input));
  } finally {
    release();
  }
}

async function embeddedLogin(page: Page, input: AuthenticateInput): Promise<Record<string, unknown>> {
  const username = input.username ?? input.email;
  const waitMs = (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  const continuing = Boolean(input.mfaCode || input.verificationMethod);
  const freshCredentials = Boolean(username && input.password) && !continuing;
  const current = classifyAuthUrl(page.url());
  const captchaPending = current.kind === 'sign_in' && (await isCaptchaShowing(page));

  if (input.interactive) {
    if (isHeadless()) {
      return {
        authenticated: false,
        error: 'visible_browser_required',
        message: 'Interactive sign-in needs a browser window the person can see. Restart the server with FREETAXUSA_HEADLESS=false.',
      };
    }
    if (current.kind !== 'signed_in' && !isMidSignIn(current) && !captchaPending) {
      await openSignInPage(page);
    }
    return report(page, await waitForAuthOutcome(page, { mode: 'person', timeoutMs: waitMs }), 'interactive');
  }

  // A sign-in already under way (captcha, two-step code, passkey offer) continues
  // from where it is, so a code the person just received is not wasted by starting over.
  if ((isMidSignIn(current) || captchaPending) && !freshCredentials) {
    return report(page, await resume(page, current, input, waitMs), 'embedded');
  }

  if (current.kind === 'signed_in' && !freshCredentials && !continuing) {
    return report(page, { kind: 'step', step: current }, 'embedded');
  }

  if (continuing) {
    return {
      authenticated: false,
      error: 'no_verification_pending',
      step: current.kind,
      message: 'No two-step verification is waiting in this browser. Call authenticate with username and password first.',
    };
  }

  if (!username || !input.password) {
    return {
      authenticated: false,
      error: 'credentials_required',
      message:
        'username and password are required for the embedded login. ' +
        'Alternatively call authenticate with interactive: true (needs FREETAXUSA_HEADLESS=false) so the person signs in themselves, ' +
        'or configure Hermes (HERMES_URL/HERMES_CLIENT_TOKEN) to broker the login.',
    };
  }

  if (await openSignInPage(page)) {
    return report(page, { kind: 'step', step: { kind: 'signed_in' } }, 'embedded');
  }
  const from = page.url();
  await submitCredentials(page, username, input.password);
  return report(page, await settle(page, agentWait(waitMs, from)), 'embedded');
}

/** Open the sign-in form. Returns true when the site went straight to the tax return because the browser is already signed in. */
async function openSignInPage(page: Page): Promise<boolean> {
  await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const signedIn = page.waitForURL(url => classifyAuthUrl(url.href).kind === 'signed_in', { timeout: 20_000 }).then(
    () => true,
    () => false,
  );
  const formShown = page.locator(SIGN_IN.username).waitFor({ state: 'visible', timeout: 20_000 }).then(
    () => false,
    () => false,
  );
  if (await Promise.race([signedIn, formShown])) return true;
  if (classifyAuthUrl(page.url()).kind === 'signed_in') return true;
  if (!(await page.locator(SIGN_IN.username).isVisible())) {
    throw new Error(
      `The FreeTaxUSA sign-in form did not appear at ${page.url()} (the site may be slow, down, or holding visitors in a waiting room). Try again shortly.`,
    );
  }
  return false;
}

/** In a visible browser the person gets time to solve a captcha; headless, it is reported at once. */
function agentWait(waitMs: number, fromUrl: string, ignoreAlerts?: string[]): WaitOptions {
  return { mode: 'agent', timeoutMs: STEP_TIMEOUT_MS, captchaTimeoutMs: isHeadless() ? 0 : waitMs, fromUrl, ignoreAlerts };
}

/** Wait for the outcome, declining the passkey offer once if it appears. */
async function settle(page: Page, opts: WaitOptions): Promise<AuthOutcome> {
  let declined = false;
  for (;;) {
    const outcome = await waitForAuthOutcome(page, opts);
    if (outcome.kind !== 'step' || outcome.step.kind !== 'passkey_offer' || declined) return outcome;
    const from = page.url();
    await declinePasskeyOffer(page);
    declined = true;
    opts = { ...opts, fromUrl: from };
  }
}

async function resume(page: Page, current: AuthStep, input: AuthenticateInput, waitMs: number): Promise<LoginOutcome> {
  const from = page.url();
  switch (current.kind) {
    case 'sign_in':
      // Only reached while the captcha is showing.
      return settle(page, agentWait(waitMs, from));

    case 'choose_verification_method': {
      if (!input.verificationMethod) return { kind: 'step', step: current };
      const pending = await chooseVerificationMethod(page, input.verificationMethod, input.phone);
      if (pending) return { kind: 'phone_needed', phones: pending.phoneNeeded };
      return settle(page, agentWait(waitMs, from));
    }

    case 'verification_code': {
      if (!input.mfaCode) return { kind: 'step', step: current };
      const before = (await readAlerts(page)).map(a => a.text);
      await submitVerificationCode(page, input.mfaCode, input.rememberDevice);
      return settle(page, agentWait(waitMs, from, before));
    }

    case 'passkey_offer':
      await declinePasskeyOffer(page);
      return settle(page, agentWait(waitMs, from));

    default:
      return { kind: 'step', step: current };
  }
}

async function report(page: Page, outcome: LoginOutcome, source: AuthSource): Promise<Record<string, unknown>> {
  switch (outcome.kind) {
    case 'step':
      return describeStep(page, outcome.step, source, []);

    case 'captcha':
    case 'timeout':
      if (source === 'interactive' && outcome.kind === 'timeout' && outcome.step.kind !== 'signed_in') {
        return {
          authenticated: false,
          waitingForPerson: true,
          step: outcome.captcha ? 'captcha' : outcome.step.kind,
          message: `Still waiting for the person to finish signing in in the browser window (currently at "${outcome.captcha ? 'captcha' : outcome.step.kind}"). Call authenticate with interactive: true to keep waiting.`,
        };
      }
      if (outcome.kind === 'captcha' || outcome.captcha) {
        return {
          authenticated: false,
          captchaRequired: true,
          step: 'captcha',
          message: isHeadless()
            ? 'FreeTaxUSA is showing an hCaptcha puzzle, which cannot be solved in a headless browser. ' +
              'Restart the server with FREETAXUSA_HEADLESS=false and call authenticate again; the person solves the puzzle in the browser window.'
            : 'FreeTaxUSA is showing an hCaptcha puzzle in the browser window. Ask the person to solve it, ' +
              'then call authenticate again with no arguments to continue.',
        };
      }
      return describeStep(page, outcome.step, source, outcome.alerts);

    case 'rejected':
      return {
        authenticated: false,
        error: 'sign_in_rejected',
        step: classifyAuthUrl(page.url()).kind,
        alerts: outcome.alerts.map(a => a.text),
        message: outcome.alerts[0].text,
      };

    case 'phone_needed':
      return {
        authenticated: false,
        mfaRequired: true,
        step: 'choose_verification_method',
        phones: outcome.phones,
        message: 'This account has several phone numbers. Ask the person which one to use, then call authenticate with verificationMethod and phone.',
      };
  }
}

const CODE_SOURCE: Record<Extract<AuthStep, { kind: 'verification_code' }>['method'], string> = {
  phone: 'by text message or voice call',
  email: 'to their email',
  authenticator_app: 'in their authenticator app',
  emergency_code: 'from their saved emergency codes',
};

const ACCOUNT_STEP_TEXT: Record<string, string> = {
  update_password: 'set a new password',
  choose_username: 'choose a username',
  verify_phone: 'verify their phone number',
  confirm_email: 'confirm their email address',
};

async function describeStep(page: Page, step: AuthStep, source: AuthSource, alerts: AuthAlert[]): Promise<Record<string, unknown>> {
  const alertTexts = alerts.map(a => a.text);
  const withAlerts = alertTexts.length ? { alerts: alertTexts } : {};

  switch (step.kind) {
    case 'signed_in':
      await discoverSidMap(page);
      return {
        authenticated: true,
        authSource: source,
        taxYear: TAX_YEAR,
        currentUrl: page.url(),
        message: 'Successfully authenticated.',
      };

    case 'choose_verification_method':
      return {
        authenticated: false,
        mfaRequired: true,
        step: step.kind,
        availableMethods: await availableVerificationMethods(page),
        phones: await availablePhones(page),
        ...withAlerts,
        message:
          'FreeTaxUSA needs a two-step verification code. Ask the person how they want to receive it, ' +
          'then call authenticate with verificationMethod (and phone if several are listed).',
      };

    case 'verification_code':
      return {
        authenticated: false,
        mfaRequired: true,
        step: step.kind,
        method: step.method,
        ...withAlerts,
        message:
          `${alertTexts.length ? `${alertTexts[0]} ` : ''}Ask the person for the code ${CODE_SOURCE[step.method]}, ` +
          'then call authenticate with mfaCode. Username and password are not needed again.',
      };

    case 'account_step':
      return {
        authenticated: false,
        step: step.name,
        ...withAlerts,
        message:
          `FreeTaxUSA requires the person to ${ACCOUNT_STEP_TEXT[step.name] ?? 'finish an account step'} before continuing. ` +
          'With FREETAXUSA_HEADLESS=false, call authenticate with interactive: true so they can finish it in the browser window.',
      };

    case 'passkey_offer':
      return {
        authenticated: false,
        step: step.kind,
        message: 'FreeTaxUSA is offering to set up a passkey and declining it did not go through. Call authenticate again with no arguments to retry.',
      };

    case 'browser_not_supported':
      return {
        authenticated: false,
        error: 'browser_not_supported',
        step: step.kind,
        message: 'FreeTaxUSA refused this browser. Try again with FREETAXUSA_HEADLESS=false.',
      };

    case 'sign_in':
      return {
        authenticated: false,
        error: 'sign_in_failed',
        step: step.kind,
        ...withAlerts,
        message: alertTexts[0] ?? 'Still on the sign-in page and FreeTaxUSA showed no message. Check the username and password.',
      };

    case 'unknown':
      return {
        authenticated: false,
        step: step.kind,
        currentUrl: page.url(),
        ...withAlerts,
        message: 'Sign-in ended on a page this server does not recognize. Run with FREETAXUSA_HEADLESS=false to see it.',
      };
  }
}

export const getSessionStatusSchema = z.object({});

export async function getSessionStatus(): Promise<Record<string, unknown>> {
  const release = await acquirePageLock();
  try {
    const page = await getPage();
    const url = page.url();
    const expired = await isSessionExpired();

    if (expired || url === 'about:blank') {
      const authStep = url === 'about:blank' ? null : classifyAuthUrl(url);
      const midSignIn = authStep !== null && (isMidSignIn(authStep) || (authStep.kind === 'sign_in' && (await isCaptchaShowing(page))));
      return filterPII({
        active: false,
        taxYear: null,
        currentSection: null,
        currentSid: null,
        authStep: authStep?.kind ?? null,
        message: midSignIn
          ? `Sign-in is in progress (at "${authStep.kind}"). Call authenticate to continue.`
          : 'No active session. Call authenticate first.',
      } satisfies SessionStatus & { authStep: string | null; message: string });
    }

    const sid = extractSidFromUrl(url);
    const title = await getPageTitle(page);

    // Try to get section name from SID map
    const sidMap = await discoverSidMap(page);
    const sectionName = sid !== null ? (sidMap.bySid.get(sid) ?? null) : null;

    return filterPII({
      active: true,
      taxYear: TAX_YEAR,
      currentSection: sectionName ?? title,
      currentSid: sid,
    } satisfies SessionStatus);
  } finally {
    release();
  }
}
