/**
 * Single sign-on (to-do item 2): signing in to the hub through outside OpenID Connect providers. Phil's decisions:
 *
 * - **Generic OIDC only.** A provider is an issuer (or its discovery URL), a client id and, for a confidential client,
 *   a secret. The relying party is `@ayepi/auth/oauth`'s `OidcClient`; nothing here knows any one provider.
 * - **Env vars only.** Providers come from `HARNESS_SSO_PROVIDERS` (`IdentityProviderConfigs`, JSON). The admin page shows
 *   them read-only, with a check and a test sign-in.
 * - **First sign-in is the admin's setting** (`SignInPolicy`): invite only, allowed email domains, or anyone.
 * - **Linking** to an existing person is by email only when the provider says `email_verified` is true.
 * - **Roles and groups** come from claims (`SsoClaimMap`) and are synced again at every sign-in.
 * - **Passwords:** once a provider is configured, only the bootstrap admin (the first account) keeps one, as a
 *   break-glass sign-in.
 *
 * A person signed in through a provider has an `ExternalIdentity` row per (issuer, subject).
 */
import { z } from 'zod';
import { ActorId, Json, Timestamp } from './primitives.ts';
import { UserRole, UserView } from './records/actors.ts';

/** A provider's id: the word in its URLs (`/auth/sso/<id>/start`). */
export const SsoProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lower case letters, digits and dashes, starting with a letter or digit');
export type SsoProviderId = z.infer<typeof SsoProviderId>;

/**
 * How a provider's claims become the person's role and groups, synced at every sign-in. The role is set from the
 * values of the `role` claim (a string or a list): any value in `admin` makes an admin; otherwise a member, but when
 * `member` is given one of its values (or an admin value) is needed to sign in at all. With neither `admin` values nor
 * a `member` list, the role isn't managed by the provider: a new person is a member and an admin's change stays. The
 * `groups` claim's values name hub groups: the person is put in the groups of those names that exist, and taken out of
 * the ones an earlier sign-in through this provider put them in that the claim no longer names.
 */
export const SsoClaimMap = z.object({
  role: z.string().min(1).default('groups').describe('The claim whose values pick the role (default "groups").'),
  admin: z.array(z.string().min(1)).default([]).describe('Values of the role claim that make an admin.'),
  member: z.array(z.string().min(1)).optional().describe('When given, values of the role claim one of which (or an admin value) is needed to sign in.'),
  groups: z.string().min(1).optional().describe('The claim whose values are hub group names to sync the person into.'),
});
export type SsoClaimMap = z.infer<typeof SsoClaimMap>;

/** Whether a claim map manages the role (it names admin values or a member list). */
export function managesRole(map: SsoClaimMap): boolean {
  return map.admin.length > 0 || map.member !== undefined;
}

/** One OpenID provider, as `HARNESS_SSO_PROVIDERS` declares it. */
export const IdentityProviderConfig = z.object({
  id: SsoProviderId,
  /** What its button says: "Continue with <label>". */
  label: z.string().min(1).max(60),
  /** The issuer, or its discovery document's URL. */
  issuer: z.url(),
  clientId: z.string().min(1),
  /** A confidential client's secret; omit for a public client. */
  clientSecret: z.string().min(1).optional(),
  scope: z.string().min(1).default('openid email profile'),
  /** Read the userinfo endpoint too, for claims the ID token leaves out (groups, often). */
  userinfo: z.boolean().default(true),
  claims: SsoClaimMap.prefault({}),
});
export type IdentityProviderConfig = z.infer<typeof IdentityProviderConfig>;

/** Every provider; ids are unique. */
export const IdentityProviderConfigs = z.array(IdentityProviderConfig).refine(
  (providers) => new Set(providers.map((p) => p.id)).size === providers.length,
  'each provider needs its own id',
);

/** An email domain, as the domains policy lists it: `example.com`. */
export const EmailDomain = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain such as example.com');

/** Who may make an account by signing in through a provider for the first time (the admin's setting). */
export const SignInPolicy = z.discriminatedUnion('mode', [
  /** Only people an admin added (by email) can sign in. */
  z.object({ mode: z.literal('invite') }),
  /** Also anyone whose verified email is at one of these domains. */
  z.object({ mode: z.literal('domains'), domains: z.array(EmailDomain).min(1).max(50) }),
  /** Anyone the provider signs in with a verified email. */
  z.object({ mode: z.literal('anyone') }),
]);
export type SignInPolicy = z.infer<typeof SignInPolicy>;

/** The policy until an admin sets one. */
export const DEFAULT_SIGN_IN_POLICY: SignInPolicy = { mode: 'invite' };

/** The hub option the policy is kept under. */
export const SIGN_IN_POLICY_OPTION = 'signInPolicy';

/** A person's account at an outside provider, linked to their hub user. */
export const ExternalIdentity = z.object({
  /** The provider's issuer, as its discovery says it. */
  issuer: z.string(),
  /** The subject: the person's id at the issuer. */
  sub: z.string(),
  provider: SsoProviderId,
  user: ActorId,
  /** The email the provider last gave. */
  email: z.string().optional(),
  linkedAt: Timestamp,
  lastSignInAt: Timestamp,
});
export type ExternalIdentity = z.infer<typeof ExternalIdentity>;

/** A provider as the sign-in page shows it: a button. */
export const SsoButton = IdentityProviderConfig.pick({ id: true, label: true });
export type SsoButton = z.infer<typeof SsoButton>;

/** A provider as the admin page shows it: its config without the secret. */
export const SsoProviderView = IdentityProviderConfig.omit({ clientSecret: true }).extend({ confidential: z.boolean() });
export type SsoProviderView = z.infer<typeof SsoProviderView>;

/** The Sign-in tab: the providers, the first-sign-in policy, the break-glass admin and the redirect to register. */
export const SignInSettings = z.object({
  providers: z.array(SsoProviderView),
  policy: SignInPolicy,
  /** The one account that keeps a password once providers are configured. */
  breakGlass: UserView.optional(),
  /** The redirect URI to register with each provider. */
  callbackUrl: z.string(),
});
export type SignInSettings = z.infer<typeof SignInSettings>;

/** One step of a provider check. */
export const SsoCheckStep = z.object({ ok: z.boolean(), detail: z.string() });
export type SsoCheckStep = z.infer<typeof SsoCheckStep>;

/** Whether the hub can reach a provider: its discovery document and its key set. */
export const SsoCheck = z.object({ provider: SsoProviderId, ok: z.boolean(), discovery: SsoCheckStep, keys: SsoCheckStep, checkedAt: Timestamp });
export type SsoCheck = z.infer<typeof SsoCheck>;

/** How a sign-in finds its person. */
export const SsoLink = z.enum([
  /** Signed in through this account before. */
  'linked',
  /** An existing person with the same verified email. */
  'email',
  /** A new account, as the policy allows. */
  'new',
  /** Nobody: refused. */
  'none',
]);
export type SsoLink = z.infer<typeof SsoLink>;

/** What signing in with some claims does (or would do, for a test sign-in). */
export const SsoOutcome = z.object({
  allowed: z.boolean(),
  /** In words: who it is and why, or why not. */
  reason: z.string(),
  link: SsoLink,
  /** The person it signs in as, when one exists already. */
  user: UserView.optional(),
  /** The role after the sign-in. */
  role: UserRole.optional(),
  /** The hub groups the claims put the person in. */
  groups: z.array(z.string()),
  /** Group names in the claims that no hub group has. */
  unknownGroups: z.array(z.string()),
});
export type SsoOutcome = z.infer<typeof SsoOutcome>;

/** A test sign-in's result, for the admin who ran it: what the provider sent and what a real sign-in would do. */
export const SsoTestResult = z.object({
  id: z.string(),
  provider: SsoProviderId,
  at: Timestamp,
  /** Why the provider sign-in itself failed, when it did. */
  problem: z.string().optional(),
  subject: z.string().optional(),
  email: z.string().optional(),
  emailVerified: z.boolean(),
  /** The ID token's and userinfo's claims together. */
  claims: z.record(z.string(), Json),
  outcome: SsoOutcome.optional(),
});
export type SsoTestResult = z.infer<typeof SsoTestResult>;

/** How a person signs in, for the People list. */
export const PersonSignIn = z.object({
  provider: SsoProviderId,
  /** The provider's label (its id when it is no longer configured). */
  label: z.string(),
  email: z.string().optional(),
  lastSignInAt: Timestamp,
});
export type PersonSignIn = z.infer<typeof PersonSignIn>;

/** A person as the People list shows them. */
export const PersonView = UserView.extend({
  disabled: z.boolean(),
  createdAt: Timestamp,
  /** The bootstrap admin: keeps a password once providers are configured. */
  breakGlass: z.boolean(),
  /** Can sign in with a password now. */
  password: z.boolean(),
  identities: z.array(PersonSignIn),
  groups: z.array(z.object({ id: ActorId, name: z.string(), synced: z.boolean() })),
});
export type PersonView = z.infer<typeof PersonView>;

/** A group as the Groups list shows it. */
export const GroupView = z.object({ id: ActorId, name: z.string(), about: z.string(), createdAt: Timestamp, members: z.number().int().min(0) });
export type GroupView = z.infer<typeof GroupView>;

/** Change a person: their name, role, or whether they can sign in. */
export const UpdateUser = z.object({ user: ActorId, name: z.string().trim().min(1).max(120).optional(), role: UserRole.optional(), disabled: z.boolean().optional() });
export type UpdateUser = z.infer<typeof UpdateUser>;

/** Put a person in a group, or take them out. */
export const SetMembership = z.object({ group: ActorId, user: ActorId, member: z.boolean() });
export type SetMembership = z.infer<typeof SetMembership>;

/** Where a provider sends people back to, under the hub's public URL. */
export const SSO_CALLBACK_PATH = '/auth/sso/callback';

/** Where a sign-in through a provider starts (a plain link; `?next=` is where to go after). */
export function ssoStartPath(provider: SsoProviderId): string {
  return `/auth/sso/${encodeURIComponent(provider)}/start`;
}

/** The People page's Sign-in tab, where a test sign-in comes back to (`?test=<id>`). */
export const SSO_TEST_PAGE = '/admin/people/sign-in';

/** The fragment key the callback hands the sign-in page its refresh token under (`/sign-in#sso=...`). */
export const SSO_HANDOFF_KEY = 'sso';
