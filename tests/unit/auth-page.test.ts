import { describe, it, expect } from 'vitest';
import { classifyAuthUrl, isMidSignIn } from '../../src/browser/auth-page.js';

describe('classifyAuthUrl', () => {
  it('treats the sign-in page as sign_in for every tax year', () => {
    for (const url of [
      'https://auth.freetaxusa.com/?PRMPT&appYear=2025',
      'https://auth.freetaxusa.com/?PRMPT&appYear=2024',
      'https://auth.freetaxusa.com/?appYear=2023',
      'https://auth.freetaxusa.com/login-sso',
    ]) {
      expect(classifyAuthUrl(url)).toEqual({ kind: 'sign_in' });
    }
  });

  it('treats the tax app as signed in', () => {
    expect(classifyAuthUrl('https://www.freetaxusa.com/taxes2025/taxcontrol?sid=15')).toEqual({ kind: 'signed_in' });
    expect(classifyAuthUrl('https://www.freetaxusa.com/taxes2023/taxcontrol')).toEqual({ kind: 'signed_in' });
  });

  it('does not treat the marketing site as signed in', () => {
    expect(classifyAuthUrl('https://www.freetaxusa.com/').kind).toBe('unknown');
    expect(classifyAuthUrl('https://www.freetaxusa.com/prior-year').kind).toBe('unknown');
  });

  it('recognizes every two-step code page, whatever the case of the path', () => {
    expect(classifyAuthUrl('https://auth.freetaxusa.com/TextVerification')).toEqual({ kind: 'verification_code', method: 'phone' });
    expect(classifyAuthUrl('https://auth.freetaxusa.com/EmailVerification')).toEqual({ kind: 'verification_code', method: 'email' });
    expect(classifyAuthUrl('https://auth.freetaxusa.com/AuthAppVerification')).toEqual({
      kind: 'verification_code',
      method: 'authenticator_app',
    });
    expect(classifyAuthUrl('https://auth.freetaxusa.com/EmergencyCodeVerification')).toEqual({
      kind: 'verification_code',
      method: 'emergency_code',
    });
  });

  it('recognizes the method chooser', () => {
    expect(classifyAuthUrl('https://auth.freetaxusa.com/verifyWithTwoStepMethod')).toEqual({ kind: 'choose_verification_method' });
  });

  it('recognizes steps after the password is accepted', () => {
    expect(classifyAuthUrl('https://auth.freetaxusa.com/passkey-upsell')).toEqual({ kind: 'passkey_offer' });
    expect(classifyAuthUrl('https://auth.freetaxusa.com/update-password')).toEqual({ kind: 'account_step', name: 'update_password' });
    expect(classifyAuthUrl('https://auth.freetaxusa.com/choose-username')).toEqual({ kind: 'account_step', name: 'choose_username' });
    expect(classifyAuthUrl('https://auth.freetaxusa.com/browser-entry-denied')).toEqual({ kind: 'browser_not_supported' });
  });

  it('reports other pages as unknown', () => {
    expect(classifyAuthUrl('https://auth.freetaxusa.com/ReclaimAccount')).toEqual({ kind: 'unknown', path: '/ReclaimAccount' });
    expect(classifyAuthUrl('about:blank').kind).toBe('unknown');
    expect(classifyAuthUrl('not a url').kind).toBe('unknown');
  });

  it('does not trust look-alike hosts', () => {
    expect(classifyAuthUrl('https://freetaxusa.com.example.net/taxes2025/taxcontrol').kind).toBe('unknown');
    expect(classifyAuthUrl('https://auth.freetaxusa.com.example.net/TextVerification').kind).toBe('unknown');
  });
});

describe('isMidSignIn', () => {
  it('is true only between a submitted password and the tax return', () => {
    expect(isMidSignIn({ kind: 'verification_code', method: 'phone' })).toBe(true);
    expect(isMidSignIn({ kind: 'choose_verification_method' })).toBe(true);
    expect(isMidSignIn({ kind: 'passkey_offer' })).toBe(true);
    expect(isMidSignIn({ kind: 'account_step', name: 'update_password' })).toBe(true);
    expect(isMidSignIn({ kind: 'sign_in' })).toBe(false);
    expect(isMidSignIn({ kind: 'signed_in' })).toBe(false);
  });
});
