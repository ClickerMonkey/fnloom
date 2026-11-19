/**
 * The People pages' words: how a person signs in, what a first-sign-in policy lets in, and a test sign-in's outcome,
 * each one sentence or a few short labels, from the hub's own shapes.
 */
import { EmailDomain, type PersonView, type SignInPolicy, type SsoLink, type SsoTestResult } from '@harness/core';
import type { SegmentOption, Tone } from '../../ui/index.ts';

/** The first-sign-in policies, in the order the Sign-in tab offers them. */
export const POLICY_OPTIONS = [
  { value: 'invite', label: 'Invite only', icon: 'mail-open' },
  { value: 'domains', label: 'Email domains', icon: 'globe' },
  { value: 'anyone', label: 'Anyone', icon: 'users' },
] as const satisfies readonly SegmentOption<SignInPolicy['mode']>[];

/** What a policy lets in, in a sentence. */
export function policyText(policy: SignInPolicy): string {
  switch (policy.mode) {
    case 'invite': return 'Only people an admin added can sign in. Add someone by their email, and their first sign-in links to them.';
    case 'domains': return `People an admin added, and anyone whose provider vouches for an email at ${listWords(policy.domains)}.`;
    case 'anyone': return 'Anyone a provider signs in with a verified email gets an account as a member.';
  }
}

/** A domain as typed into the domains box, or undefined when it isn't one. */
export function readDomain(text: string): string | undefined {
  const read = EmailDomain.safeParse(text.replace(/^@/, ''));
  return read.success ? read.data : undefined;
}

/** How a person signs in, as short labels: each provider they used, and the break-glass password. */
export function signInLabels(person: PersonView): string[] {
  const labels = [...new Set(person.identities.map((i) => i.label))];
  if (person.password) labels.push(person.breakGlass ? 'Break-glass password' : 'Password');
  return labels;
}

/** How a sign-in found its person, in words. */
export const LINK_WORDS = {
  linked: 'Linked before',
  email: 'Joined by verified email',
  new: 'New account',
  none: 'Nobody',
} as const satisfies Record<SsoLink, string>;

/** A test sign-in at a glance: its tone and title. */
export function testHeadline(result: SsoTestResult): { readonly tone: Tone; readonly title: string } {
  if (result.problem !== undefined) return { tone: 'danger', title: 'The provider sign-in failed' };
  if (result.outcome?.allowed === true) return { tone: 'ok', title: 'This sign-in would work' };
  return { tone: 'warn', title: 'This sign-in would be refused' };
}

/** Words in a list: "a", "a or b", "a, b or c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1] ?? ''}`;
}
