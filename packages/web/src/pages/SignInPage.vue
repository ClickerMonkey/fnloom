<script setup lang="ts">
/**
 * Sign in, or make the admin account on a new hub. Afterwards it returns to the page that sent you here. The form's
 * checks are the hub's own (see `SignInForm`). The fields carry the names and autocomplete hints password managers
 * look for, and after signing in with "Remember me" ticked the page also hands the browser the credential where it
 * takes one (`navigator.credentials`, secure pages only).
 */
import { onMounted, reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppBrand from '../app/AppBrand.vue';
import { links, safeNext } from '../app/routes.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiButton, UiInput, UiSkeleton } from '../ui/index.ts';

const form = useStores().signInForm();
const input = reactive({ email: form.remembered.email ?? '', password: '', name: '', remember: form.remembered.remember });
const route = useRoute();
const router = useRouter();

onMounted(() => { void form.load(); });

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
    await router.replace(safeNext(route.query['next']) ?? links.chat());
  }
}
</script>

<template>
  <div class="wrap">
    <div class="card">
      <AppBrand class="brand" :size="36" />
      <template v-if="form.loading.value">
        <UiSkeleton shape="lines" :lines="1" />
        <UiSkeleton shape="block" :size="40" />
        <UiSkeleton shape="block" :size="40" />
        <UiSkeleton shape="block" :size="40" />
      </template>
      <form v-else class="form" method="post" action="" novalidate data-testid="sign-in-form" @submit.prevent="submit">
        <div class="titles">
          <h1 class="title">{{ form.needsAdmin ? 'Set up your hub' : 'Welcome back' }}</h1>
          <p class="lead">{{ form.needsAdmin ? 'Make the admin account. You can add people later.' : `Sign in to ${form.setup.value?.name ?? 'your hub'}.` }}</p>
        </div>
        <UiBanner v-if="form.problem.value !== ''" tone="danger" data-testid="sign-in-problem">{{ form.problem.value }}</UiBanner>
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
        <UiButton type="submit" variant="primary" size="lg" block :loading="form.busy.value">{{ form.needsAdmin ? 'Create account and sign in' : 'Sign in' }}</UiButton>
      </form>
      <p v-if="form.setup.value" class="version">{{ form.setup.value.name }} · {{ form.setup.value.version }}</p>
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
.form { display: grid; gap: var(--space-4); animation: ui-fade-in var(--medium) var(--ease); }
.titles { display: grid; gap: var(--space-1); }
.title { margin: 0; font-size: var(--text-2xl); font-weight: var(--weight-strong); }
.lead { margin: 0; color: var(--text-dim); }
.remember { display: flex; align-items: center; gap: var(--space-2); width: fit-content; min-height: 32px; cursor: pointer; color: var(--text-dim); }
.remember input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.version { margin: 0; color: var(--text-faint); font-size: var(--text-xs); text-align: center; }
@media (max-width: 420px) { .card { padding: var(--space-5); } }
</style>
