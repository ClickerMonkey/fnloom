<script setup lang="ts">
/**
 * Sign in, or make the admin account on a new hub. Afterwards it returns to the page that sent you here (`?next=`).
 *
 * With SSO providers configured (`setup.sso`), each is a "Continue with …" button: a plain link to the hub's start
 * route, which sends the browser to the provider. The provider's way back lands here: with the new session in the URL
 * fragment (`#sso=`, swapped for tokens at once and wiped from the address bar), or with `?problem=` when the sign-in
 * was refused. Passwords then belong to the break-glass admin only, so the password form folds away under "Sign in with
 * a password". Without providers the page is the password form, as before.
 *
 * The form's checks are the hub's own (see `SignInForm`). The fields carry the names and autocomplete hints password
 * managers look for, and after signing in with "Remember me" ticked the page also hands the browser the credential where
 * it takes one (`navigator.credentials`, secure pages only).
 */
import { SSO_HANDOFF_KEY, ssoStartPath } from '@harness/core';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppBrand from '../app/AppBrand.vue';
import { links, safeNext } from '../app/routes.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiButton, UiIcon, UiInput, UiSkeleton } from '../ui/index.ts';

const { signInForm, identity } = useStores();
const form = signInForm();
const hubName = identity.name;
const version = identity.version;
const input = reactive({ email: form.remembered.email ?? '', password: '', name: '', remember: form.remembered.remember });
const route = useRoute();
const router = useRouter();
/** The password form, shown at once without providers, folded under its own button with them. */
const passwordOpen = ref(false);

const next = computed(() => safeNext(route.query['next']));
/** Why a provider sign-in was refused, as the hub's redirect back says. */
const refused = computed(() => (typeof route.query['problem'] === 'string' ? route.query['problem'] : ''));
const problem = computed(() => form.problem.value || refused.value);
const providers = computed(() => (form.needsAdmin ? [] : form.providers));
const showPassword = computed(() => form.needsAdmin || providers.value.length === 0 || passwordOpen.value);
/** A provider button's link: the hub's start route, coming back to where the person was going. */
const startHref = (provider: string): string => `${ssoStartPath(provider)}${next.value === undefined ? '' : `?${new URLSearchParams({ next: next.value }).toString()}`}`;

/** The hand-over the hub's callback left in the fragment, if any. */
function handover(): string | undefined {
  const value = new URLSearchParams(route.hash.replace(/^#/, '')).get(SSO_HANDOFF_KEY);
  return value === null || value === '' ? undefined : value;
}

onMounted(async () => {
  const refresh = handover();
  if (refresh !== undefined) {
    // the token leaves the address bar (and the history entry) before anything else runs
    await router.replace({ query: next.value === undefined ? {} : { next: next.value }, hash: '' });
    if (await form.finishSso(refresh)) { await router.replace(next.value ?? links.chat()); return; }
  }
  void form.load();
});

/** The browser's `PasswordCredential`, where it has one. */
type PasswordCredentialCtor = new (data: { id: string; password: string; name?: string }) => Credential;

/** Whether the browser's `PasswordCredential` is there (it is missing from TypeScript's DOM types). */
function isCredentialCtor(value: unknown): value is PasswordCredentialCtor {
  return typeof value === 'function';
}

/** Offer the browser the email and password to save; best effort, and only where the browser takes it. */
async function offerToSave(email: string, password: string): Promise<void> {
  const Ctor: unknown = Reflect.get(window, 'PasswordCredential');
  if (!isCredentialCtor(Ctor) || !window.isSecureContext) { return; }
  try {
    await navigator.credentials.store(new Ctor({ id: email, password, name: email }));
  } catch {
    // the browser said no, or the person dismissed it
  }
}

async function submit(): Promise<void> {
  if (await form.submit(input)) {
    if (input.remember) { await offerToSave(input.email, input.password); }
    await router.replace(next.value ?? links.chat());
  }
}
</script>

<template>
  <div class="wrap">
    <div class="card">
      <AppBrand class="brand" :name="hubName" :size="36" />
      <template v-if="form.loading.value">
        <UiSkeleton shape="lines" :lines="1" />
        <UiSkeleton shape="block" :size="40" />
        <UiSkeleton shape="block" :size="40" />
        <UiSkeleton shape="block" :size="40" />
      </template>
      <div v-else class="body">
        <div class="titles">
          <h1 class="title">{{ form.needsAdmin ? 'Set up your hub' : 'Welcome back' }}</h1>
          <p class="lead">{{ form.needsAdmin ? 'Make the admin account. You can add people later.' : `Sign in to ${hubName}.` }}</p>
        </div>
        <UiBanner v-if="problem !== ''" tone="danger" data-testid="sign-in-problem">{{ problem }}</UiBanner>

        <nav v-if="providers.length > 0" class="providers" aria-label="Sign in with">
          <a v-for="provider in providers" :key="provider.id" class="provider" :href="startHref(provider.id)" :data-testid="`sso-${provider.id}`">
            <UiIcon name="key" :size="18" />
            <span>Continue with {{ provider.label }}</span>
            <UiIcon class="go" name="arrow-right" :size="16" />
          </a>
        </nav>
        <button
          v-if="providers.length > 0 && !passwordOpen" type="button" class="password-toggle" data-testid="password-toggle" :aria-expanded="passwordOpen"
          @click="passwordOpen = true"
        >
          Admin? Sign in with a password
        </button>

        <form v-if="showPassword" class="form" method="post" action="" novalidate data-testid="sign-in-form" @submit.prevent="submit">
          <p v-if="providers.length > 0" class="divider"><span>Break-glass password</span></p>
          <UiInput v-if="form.needsAdmin" v-model="input.name" label="Your name" name="name" autocomplete="name" required :error="form.fields.value.name ?? ''" autofocus />
          <UiInput v-model="input.email" label="Email" name="username" type="email" autocomplete="username" required :error="form.fields.value.email ?? ''" :autofocus="!form.needsAdmin && input.email === ''" />
          <UiInput
            v-model="input.password" label="Password" name="password" type="password" revealable :autocomplete="form.needsAdmin ? 'new-password' : 'current-password'" required
            :autofocus="!form.needsAdmin && input.email !== ''"
            :hint="form.needsAdmin ? 'At least 8 characters.' : ''" :error="form.fields.value.password ?? ''"
          />
          <label class="remember">
            <input v-model="input.remember" type="checkbox" name="remember" data-testid="remember-me" />
            <span>Remember me</span>
          </label>
          <UiButton type="submit" :variant="providers.length > 0 ? 'secondary' : 'primary'" size="lg" block :loading="form.busy.value">{{ form.needsAdmin ? 'Create account and sign in' : 'Sign in' }}</UiButton>
        </form>
      </div>
      <p v-if="version !== ''" class="version" data-testid="hub-version">{{ hubName }} · {{ version }}</p>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100%; display: grid; place-items: center; padding: max(var(--space-5), var(--safe-top)) var(--space-4) max(var(--space-5), var(--safe-bottom));
  background: radial-gradient(1200px 600px at 50% -10%, var(--accent-soft), transparent 70%);
}
.card {
  width: min(400px, 100%); display: grid; gap: var(--space-4); padding: var(--space-6); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); animation: ui-rise-in var(--slow) var(--ease);
}
.brand { margin-bottom: var(--space-1); }
.body, .form { display: grid; gap: var(--space-4); animation: ui-fade-in var(--medium) var(--ease); }
.titles { display: grid; gap: var(--space-1); }
.title { margin: 0; font-size: var(--text-2xl); font-weight: var(--weight-strong); }
.lead { margin: 0; color: var(--text-dim); }
.providers { display: grid; gap: var(--space-2); }
.provider {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 48px; padding: 0 var(--space-4);
  border: 1px solid var(--border-strong, var(--border)); border-radius: var(--radius-lg); background: var(--surface); color: var(--text);
  font-weight: var(--weight-medium); text-decoration: none;
  transition: border-color var(--fast) var(--ease), background-color var(--fast) var(--ease), transform var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}
.provider:hover { border-color: var(--accent); background: var(--accent-soft); box-shadow: var(--shadow-sm); }
.provider:active { transform: translateY(1px); }
.provider:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.provider .go { color: var(--text-faint); transition: transform var(--fast) var(--ease), color var(--fast) var(--ease); }
.provider:hover .go { color: var(--accent); transform: translateX(2px); }
.password-toggle {
  justify-self: center; min-height: 32px; padding: 0 var(--space-2); border: 0; background: transparent; color: var(--text-dim); font-size: var(--text-sm);
  cursor: pointer; text-decoration: underline; text-underline-offset: 3px;
}
.password-toggle:hover { color: var(--text); }
.divider { display: flex; align-items: center; gap: var(--space-3); margin: 0; color: var(--text-faint); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.remember { display: flex; align-items: center; gap: var(--space-2); width: fit-content; min-height: 32px; cursor: pointer; color: var(--text-dim); }
.remember input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.version { margin: 0; color: var(--text-faint); font-size: var(--text-xs); text-align: center; }
@media (max-width: 420px) { .card { padding: var(--space-5); } }
</style>
