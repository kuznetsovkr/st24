import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CookieOptions, Request, Response } from 'express';
import {
  AUTH_COOKIE_NAME, CSRF_COOKIE_NAME, clearAuthCookies, getRequestAuthToken,
  hasValidCsrfToken, setAuthCookies, signToken, verifyToken
} from './auth';

const request = (cookie?: string, csrf?: string, authorization?: string) => ({
  headers: { cookie, authorization },
  header: (name: string) => name === 'x-csrf-token' ? csrf : undefined
}) as unknown as Request;

test('new cookies use canonical names and win over legacy/header credentials', () => {
  assert.equal(AUTH_COOKIE_NAME, 'karcher_auth_token');
  assert.equal(CSRF_COOKIE_NAME, 'karcher_csrf_token');
  assert.deepEqual(getRequestAuthToken(request(
    'her_auth_token=old; karcher_auth_token=new', undefined, 'Bearer header'
  )), { token: 'new', source: 'cookie' });
  assert.deepEqual(getRequestAuthToken(request(undefined, undefined, 'Bearer header')),
    { token: 'header', source: 'header' });
});

test('pre-rename signed sessions remain valid with the unchanged JWT secret', () => {
  process.env.JWT_SECRET = 'synthetic-auth-rename-test-secret-not-production';
  const payload = { userId: 'synthetic', phone: '70000000000', role: 'customer', csrfToken: 'old-csrf' };
  const signed = signToken(payload);
  const found = getRequestAuthToken(request(`her_auth_token=${encodeURIComponent(signed)}`));
  assert.equal(found.source, 'cookie');
  assert.equal(verifyToken(found.token!).userId, payload.userId);
  assert.equal(hasValidCsrfToken(request('her_csrf_token=old-csrf', 'old-csrf'), payload.csrfToken), true);
});

test('legacy compatibility preserves the header/cookie/JWT CSRF triple check', () => {
  for (const name of ['karcher_csrf_token', 'her_csrf_token']) {
    assert.equal(hasValidCsrfToken(request(`${name}=expected`, 'expected'), 'expected'), true);
    assert.equal(hasValidCsrfToken(request(`${name}=expected`), 'expected'), false);
    assert.equal(hasValidCsrfToken(request(`${name}=expected`, 'wrong'), 'expected'), false);
    assert.equal(hasValidCsrfToken(request(`${name}=expected`, 'expected'), 'different-jwt'), false);
  }
  assert.equal(hasValidCsrfToken(request(undefined, 'expected'), 'expected'), false);
  assert.equal(hasValidCsrfToken(request(
    'karcher_csrf_token=current; her_csrf_token=old', 'old'), 'old'), false);
});

test('only canonical cookies are issued; logout clears both generations', () => {
  process.env.NODE_ENV = 'production';
  const issued: Array<{ name: string; options: CookieOptions }> = [];
  const cleared: Array<{ name: string; options: CookieOptions }> = [];
  const response = {
    cookie: (name: string, _value: string, options: CookieOptions) => { issued.push({ name, options }); },
    clearCookie: (name: string, options: CookieOptions) => { cleared.push({ name, options }); }
  } as unknown as Response;
  setAuthCookies(response, 'synthetic-token', 'synthetic-csrf');
  assert.deepEqual(issued.map(c => c.name), ['karcher_auth_token', 'karcher_csrf_token']);
  assert.equal(issued[0].options.httpOnly, true);
  assert.equal(issued[1].options.httpOnly, false);
  assert.ok(issued.every(c => c.options.secure && c.options.path === '/'));
  clearAuthCookies(response);
  assert.deepEqual(cleared.map(c => c.name).sort(),
    ['her_auth_token', 'her_csrf_token', 'karcher_auth_token', 'karcher_csrf_token']);
  assert.ok(cleared.every(c => c.options.secure && c.options.path === '/'));
});
