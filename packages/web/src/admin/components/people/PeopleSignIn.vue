<script setup lang="ts">
/**
 * The Sign-in tab: how people sign in. The providers come from the hub's env (`HARNESS_SSO_PROVIDERS`) and show
 * read-only, each with the redirect URI to register, how its claims set roles and groups, Check (the hub fetches its
 * discovery document and key set now) and Test sign-in (a real sign-in at the provider that signs nobody in: it comes
 * back here with `?test=` and shows what the provider sent and what a sign-in would do). Below, who may make an account
 * at their first sign-in (the admin's setting), and the break-glass admin who keeps a password.
 */
import type { SignInPolicy, SsoProviderView } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { useRouteQuery } from '../../../app/url.ts';
import { ROUTES } from '../../../app/routes.ts';
import { useStores } from '../../../state/stores.ts';
import { UiBadge, UiBanner, UiButton, UiCard, UiChipInput, UiCodeBlock, UiIcon, UiSegmented, UiSkeleton } from '../../../ui/index.ts';
import { copyText } from '../../../ui/clipboard.ts';
import { LINK_WORDS, POLICY_OPTIONS, policyText, readDomain, testHeadline } from '../../logic/people.ts';

const { admin, toasts } = useStores();
const people = admin.people;
const query = useRouteQuery(ROUTES.people);
const test = query.text('test');

const settings = computed(() => people.signIn.value.value);
const providers = computed(() => settings.value?.providers ?? []);
const result = computed(() => people.test.value.value);
const headline = computed(() => (result.value === undefined ? undefined : testHeadline(result.value)));

const mode = ref<SignInPolicy['mode']>('invite');
const domains = ref<readonly string[]>([]);
const draft = computed<SignInPolicy>(() => (mode.value === 'domains' ? { mode: 'domains', domains: [...domains.value] } : { mode: mode.value }));
const dirty = computed(() => settings.value !== undefined && JSON.stringify(draft.value) !== JSON.stringify(settings.value.policy));
const policyProblem = computed(() => (mode.value === 'domains' && domains.value.length === 0 ? 'Add at least one domain.' : ''));

watch(() => settings.value?.policy, (policy) => {
  if (policy === undefined) return;
  mode.value = policy.mode;
  domains.value = policy.mode === 'domains' ? policy.domains : [];
}, { immediate: true });
watch(test, (id) => { if (id !== '') void people.loadTest(id); else people.test.reset(); }, { immediate: true });

/** How a provider's claims set roles and groups, in short lines. */
function claimLines(provider: SsoProviderView): string[] {
  const { claims } = provider;
  const lines: string[] = [];
  if (claims.admin.length > 0) lines.push(`"${claims.role}" with ${claims.admin.map((v) => `"${v}"`).join(' or ')} makes an admin`);
  if (claims.member !== undefined) lines.push(`"${claims.role}" must include ${[...claims.admin, ...claims.member].map((v) => `"${v}"`).join(' or ')} to sign in`);
  if (lines.length === 0) lines.push('Roles are set here, not by the provider');
  lines.push(claims.groups === undefined ? 'Groups are set here, not by the provider' : `"${claims.groups}" names the groups to put them in`);
  return lines;
}

/** The last check of a provider, step by step (none until it is checked). */
function checkSteps(provider: SsoProviderView): Array<{ name: string; ok: boolean; detail: string }> {
  const check = people.checks.value.get(provider.id);
  return check === undefined ? [] : [{ name: 'Discovery', ...check.discovery }, { name: 'Signing keys', ...check.keys }];
}

async function savePolicy(): Promise<void> {
  if (policyProblem.value !== '') return;
  const done = await people.setPolicy(draft.value);
  if (done.ok) toasts.ok('Saved who can join'); else toasts.error(done.problem);
}

async function startTest(provider: SsoProviderView): Promise<void> {
  const started = await people.startTest(provider.id);
  if (!started.ok) { toasts.error(started.problem); return; }
  // the provider sends the browser back to this tab with the result's id
  window.location.assign(started.value.url);
}

async function copy(text: string): Promise<void> {
  if (await copyText(text)) toasts.ok('Copied');
}
</script>

<template>
  <div class="sign-in-tab">
    <UiBanner v-if="people.signIn.problem.value !== ''" tone="danger">{{ people.signIn.problem.value }}</UiBanner>
    <UiSkeleton v-if="settings === undefined && people.signIn.loading.value" shape="lines" :lines="6" />

    <UiCard v-if="result && headline" class="test" :title="headline.title" :subtitle="`Test sign-in through ${providers.find((p) => p.id === result?.provider)?.label ?? result.provider}`" data-testid="sso-test">
      <template #actions><UiButton size="sm" variant="ghost" icon="x" aria-label="Close the test result" @click="test = ''" /></template>
      <UiBanner :tone="headline.tone">{{ result.problem ?? result.outcome?.reason ?? '' }}</UiBanner>
      <dl v-if="result.problem === undefined" class="facts">
        <dt>Subject</dt><dd class="mono">{{ result.subject }}</dd>
        <dt>Email</dt>
        <dd>{{ result.email ?? 'None given' }} <UiBadge v-if="result.email" :tone="result.emailVerified ? 'ok' : 'warn'">{{ result.emailVerified ? 'Verified' : 'Not verified' }}</UiBadge></dd>
        <template v-if="result.outcome">
          <dt>Finds</dt><dd>{{ LINK_WORDS[result.outcome.link] }}{{ result.outcome.user ? ` · ${result.outcome.user.name}` : '' }}</dd>
          <dt v-if="result.outcome.role">Role</dt><dd v-if="result.outcome.role">{{ result.outcome.role === 'admin' ? 'Admin' : 'Member' }}</dd>
          <dt>Groups</dt>
          <dd>
            {{ result.outcome.groups.join(', ') || 'None' }}
            <span v-if="result.outcome.unknownGroups.length > 0" class="dim"> · no group here named {{ result.outcome.unknownGroups.join(', ') }}</span>
          </dd>
        </template>
      </dl>
      <details v-if="Object.keys(result.claims).length > 0" class="claims">
        <summary>Everything the provider sent</summary>
        <UiCodeBlock :code="JSON.stringify(result.claims, null, 2)" language="json" />
      </details>
    </UiCard>
    <UiBanner v-else-if="test !== '' && people.test.problem.value !== ''" tone="warn">{{ people.test.problem.value }}</UiBanner>

    <template v-if="settings">
      <section class="section">
        <header class="head">
          <h2 class="title">Sign-in providers</h2>
          <p class="description">Set in the hub's environment (<code>HARNESS_SSO_PROVIDERS</code>), so they show here read-only.</p>
        </header>
        <UiCard v-if="providers.length === 0" flat class="empty">
          <div class="empty-body">
            <UiIcon name="key" :size="28" />
            <p><strong>No provider yet.</strong> People sign in with a password until one is set. Add any OpenID Connect provider (Okta, Entra ID, Google, Keycloak, Authentik…) to <code>HARNESS_SSO_PROVIDERS</code> and restart the hub. Register this redirect URI with it:</p>
            <button type="button" class="uri" @click="copy(settings.callbackUrl)"><code>{{ settings.callbackUrl }}</code><UiIcon name="copy" :size="14" /></button>
          </div>
        </UiCard>
        <div class="providers">
          <UiCard v-for="provider in providers" :key="provider.id" :title="provider.label" :subtitle="provider.issuer" :data-testid="`provider-${provider.id}`">
            <template #actions><UiBadge>{{ provider.confidential ? 'Confidential client' : 'Public client' }}</UiBadge></template>
            <dl class="facts">
              <dt>Client id</dt><dd class="mono">{{ provider.clientId }}</dd>
              <dt>Scopes</dt><dd class="mono">{{ provider.scope }}</dd>
              <dt>Redirect URI</dt>
              <dd><button type="button" class="uri" :title="'Copy'" @click="copy(settings.callbackUrl)"><code>{{ settings.callbackUrl }}</code><UiIcon name="copy" :size="14" /></button></dd>
              <dt>Claims</dt>
              <dd><ul class="lines"><li v-for="line in claimLines(provider)" :key="line">{{ line }}</li></ul></dd>
            </dl>
            <ul v-if="checkSteps(provider).length > 0" class="checks" aria-live="polite">
              <li v-for="step in checkSteps(provider)" :key="step.name" class="check" :class="{ ok: step.ok }">
                <UiIcon :name="step.ok ? 'check' : 'x'" :size="14" />
                <span class="check-name">{{ step.name }}</span>
                <span class="check-detail">{{ step.detail }}</span>
              </li>
            </ul>
            <template #footer>
              <UiButton variant="secondary" icon="refresh" :loading="people.checking.value === provider.id" :data-testid="`check-${provider.id}`" @click="people.check(provider.id)">Check</UiButton>
              <UiButton variant="ghost" icon="external" :loading="people.save.busy.value" :data-testid="`test-${provider.id}`" @click="startTest(provider)">Test sign-in</UiButton>
            </template>
          </UiCard>
        </div>
      </section>

      <UiCard title="Who can join" subtitle="When someone signs in through a provider for the first time and nobody here has their email yet." data-testid="sign-in-policy">
        <div class="policy">
          <UiSegmented v-model="mode" :options="POLICY_OPTIONS" label="Who can join" />
          <UiChipInput
            v-if="mode === 'domains'" v-model="domains" label="Email domains" placeholder="example.com" :read="readDomain" refusal="That isn’t a domain."
            hint="Their provider must vouch for the email." testid="policy-domains"
          />
          <p class="description">{{ policyText(draft) }}</p>
          <p v-if="policyProblem !== ''" class="problem" role="alert">{{ policyProblem }}</p>
        </div>
        <template #footer>
          <UiButton variant="primary" :disabled="!dirty || policyProblem !== ''" :loading="people.save.busy.value" data-testid="save-policy" @click="savePolicy">Save</UiButton>
        </template>
      </UiCard>

      <UiCard title="Break-glass admin" subtitle="Once a provider is set, only this account keeps a password, for when a provider is down.">
        <p v-if="settings.breakGlass" class="description"><strong>{{ settings.breakGlass.name }}</strong> ({{ settings.breakGlass.email }}) signs in with a password on the sign-in page. Everyone else signs in through a provider.</p>
        <p v-else class="description">No account has a password yet.</p>
      </UiCard>
    </template>
  </div>
</template>

<style scoped>
.sign-in-tab { display: grid; gap: var(--space-5); min-width: 0; }
.section { display: grid; gap: var(--space-3); min-width: 0; }
.head { min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: var(--space-4); }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
.facts dt { color: var(--text-dim); }
.facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.mono, code { font-family: var(--font-mono); font-size: var(--text-xs); }
.dim { color: var(--text-dim); }
.lines { display: grid; gap: 2px; margin: 0; padding-left: var(--space-4); }
.uri {
  display: inline-flex; align-items: center; gap: var(--space-2); max-width: 100%; padding: 2px var(--space-2); border: 1px dashed var(--border);
  border-radius: var(--radius-sm); background: transparent; color: var(--text); cursor: copy; text-align: left; overflow-wrap: anywhere;
}
.uri:hover { border-color: var(--accent); }
.checks { display: grid; gap: var(--space-1); margin: var(--space-3) 0 0; padding: 0; list-style: none; }
.check { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: baseline; gap: var(--space-2); color: var(--danger); font-size: var(--text-sm); animation: ui-fade-in var(--medium) var(--ease); }
.check.ok { color: var(--ok, var(--accent)); }
.check-name { font-weight: var(--weight-medium); }
.check-detail { min-width: 0; color: var(--text-dim); overflow-wrap: anywhere; }
.empty-body { display: grid; justify-items: start; gap: var(--space-3); color: var(--text-dim); }
.empty-body p { margin: 0; }
.policy { display: grid; gap: var(--space-3); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.test { animation: ui-rise-in var(--slow) var(--ease); }
.claims summary { cursor: pointer; color: var(--text-dim); font-size: var(--text-sm); margin-top: var(--space-3); }
@media (max-width: 520px) { .facts { grid-template-columns: minmax(0, 1fr); } .facts dt { margin-top: var(--space-1); } }
</style>
