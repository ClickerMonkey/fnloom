import { describe, expect, it } from 'vitest';
import type { RemoteAuth } from '@harness/core';
import {
  accountLabel, connectForm, credentialHeaders, credentialsFromForm, instanceConnectOf, keyConnectOf, maskHeaders, readCredentials, secretHeaderNames, sharedHeaders, usesConnections,
} from './remote-auth.ts';

const PERSON_BEARER: RemoteAuth = { kind: 'bearer', per: 'person' };
const PERSON_HEADERS: RemoteAuth = { kind: 'headers', per: 'person', names: ['X-Key', 'X-Org'] };

describe('remote auth for instance-scoped systems', () => {
  it('says how people connect: OAuth, shared OAuth, a form, or nothing', () => {
    expect(instanceConnectOf('Linear', { kind: 'oauth', per: 'person' })).toEqual({ flow: { flow: 'oauth' }, share: false, title: 'Sign in to Linear' });
    expect(instanceConnectOf('Linear', { kind: 'oauth', per: 'shared' })).toMatchObject({ share: true, title: 'Sign in to Linear for everyone' });
    expect(instanceConnectOf('Weather', PERSON_BEARER)).toMatchObject({ flow: { flow: 'form' }, title: 'Connect to Weather' });
    expect(instanceConnectOf('Weather', { kind: 'bearer', per: 'shared', token: 't' })).toEqual({ title: 'Weather' });
    expect(instanceConnectOf('Weather', { kind: 'none' })).toEqual({ title: 'Weather' });
    expect([PERSON_BEARER, { kind: 'none' } as const].map(usesConnections)).toEqual([true, false]);
    expect(connectForm({ kind: 'oauth', per: 'person' })).toBeUndefined();
  });

  it('reads a filled form into credentials, or says what is missing', () => {
    expect(credentialsFromForm(PERSON_BEARER, { token: 'abc' })).toEqual({ credentials: { token: 'abc' } });
    expect(credentialsFromForm(PERSON_BEARER, { token: '' })).toEqual({ problem: 'Give your token.' });
    expect(credentialsFromForm(PERSON_HEADERS, { 'X-Key': 'k', 'X-Org': 'o' })).toEqual({ credentials: { headers: { 'X-Key': 'k', 'X-Org': 'o' } } });
    expect(credentialsFromForm(PERSON_HEADERS, { 'X-Key': 'k' })).toEqual({ problem: 'Give a value for every header.' });
    expect(credentialsFromForm({ kind: 'none' }, {})).toEqual({ problem: 'This service connects without a form.' });
  });

  it('turns credentials and shared config into headers, and masks the secret ones', () => {
    expect(credentialHeaders({ token: 't' })).toEqual({ authorization: 'Bearer t' });
    expect(credentialHeaders({ headers: { 'X-Key': 'k' } })).toEqual({ 'X-Key': 'k' });
    expect(credentialHeaders({ accessToken: 'a', tokenType: 'Bearer' })).toEqual({ authorization: 'Bearer a' });
    expect(sharedHeaders({ kind: 'bearer', per: 'shared', token: 's' })).toEqual({ authorization: 'Bearer s' });
    expect(sharedHeaders({ kind: 'headers', per: 'shared', names: ['X-Key'], values: { 'X-Key': 'v' } })).toEqual({ 'X-Key': 'v' });
    expect(sharedHeaders(PERSON_BEARER)).toEqual({});
    const secret = secretHeaderNames(PERSON_HEADERS);
    expect(maskHeaders({ Authorization: 'Bearer abcdefghijklmnop', 'x-org': 'short', Accept: 'json' }, secret)).toEqual({ Authorization: '••••mnop', 'x-org': '••••', Accept: 'json' });
  });

  it('reads stored credentials and labels them without the secret', () => {
    expect(readCredentials({ token: 'abcd1234' })).toEqual({ token: 'abcd1234' });
    expect(readCredentials({ nope: 1 })).toBeUndefined();
    expect(accountLabel({ token: 'abcd1234' })).toBe('Token ending 1234');
    expect(accountLabel({ headers: { 'X-Key': 'k' } })).toBe('Headers X-Key');
    expect(accountLabel({ accessToken: 'a', tokenType: 'Bearer' })).toBe('Signed in');
  });
});

describe('remote auth for key-scoped systems (records that hold no secret)', () => {
  it('says how people connect to a key: a shared token is one admin form for everyone, a per-person one each person\'s own', () => {
    expect(keyConnectOf('Tracker', { kind: 'bearer', per: 'shared' })).toMatchObject({ flow: { flow: 'form' }, share: true, title: "Set Tracker's sign-in for everyone" });
    expect(keyConnectOf('Tracker', { kind: 'headers', per: 'shared', names: ['X-Key'] })).toMatchObject({ flow: { flow: 'form' }, share: true });
    expect(keyConnectOf('Tracker', PERSON_BEARER)).toEqual(instanceConnectOf('Tracker', PERSON_BEARER));
    expect(keyConnectOf('Tracker', { kind: 'none' })).toEqual({ title: 'Tracker' });
    expect(keyConnectOf('Linear', { kind: 'oauth', per: 'shared' })).toMatchObject({ flow: { flow: 'oauth' }, share: true });
  });

  it('reads a shared form only when asked to (an admin\'s, for a key)', () => {
    const shared: RemoteAuth = { kind: 'bearer', per: 'shared' };
    expect(connectForm(shared)).toBeUndefined();
    expect(credentialsFromForm(shared, { token: 't' })).toEqual({ problem: 'This service connects without a form.' });
    expect(credentialsFromForm(shared, { token: 't' }, 'any')).toEqual({ credentials: { token: 't' } });
    expect(credentialsFromForm({ kind: 'headers', per: 'shared', names: ['X-Key'] }, { 'X-Key': 'k' }, 'any')).toEqual({ credentials: { headers: { 'X-Key': 'k' } } });
  });
});
