<script setup lang="ts">
/**
 * Sign in, or make the admin account on a new hub. Afterwards it returns to the page that sent you here. The form's
 * checks are the hub's own (see `SignInForm`).
 */
import { onMounted, reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppBrand from '../app/AppBrand.vue';
import { links, safeNext } from '../app/routes.ts';
import { useStores } from '../state/stores.ts';
import { UiBanner, UiButton, UiInput, UiSkeleton } from '../ui/index.ts';

const form = useStores().signInForm();
const input = reactive({ email: '', password: '', name: '' });
const route = useRoute();
const router = useRouter();

onMounted(() => { void form.load(); });

async function submit(): Promise<void> {
  if (await form.submit(input)) {
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
      <form v-else class="form" novalidate data-testid="sign-in-form" @submit.prevent="submit">
        <div class="titles">
          <h1 class="title">{{ form.needsAdmin ? 'Set up your hub' : 'Welcome back' }}</h1>
          <p class="lead">{{ form.needsAdmin ? 'Make the admin account. You can add people later.' : `Sign in to ${form.setup.value?.name ?? 'your hub'}.` }}</p>
        </div>
        <UiBanner v-if="form.problem.value !== ''" tone="danger" data-testid="sign-in-problem">{{ form.problem.value }}</UiBanner>
        <UiInput v-if="form.needsAdmin" v-model="input.name" label="Your name" autocomplete="name" required :error="form.fields.value.name ?? ''" autofocus />
        <UiInput v-model="input.email" label="Email" type="email" autocomplete="email" required :error="form.fields.value.email ?? ''" :autofocus="!form.needsAdmin" />
        <UiInput
          v-model="input.password" label="Password" type="password" :autocomplete="form.needsAdmin ? 'new-password' : 'current-password'" required
          :hint="form.needsAdmin ? 'At least 8 characters.' : ''" :error="form.fields.value.password ?? ''"
        />
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
.version { margin: 0; color: var(--text-faint); font-size: var(--text-xs); text-align: center; }
@media (max-width: 420px) { .card { padding: var(--space-5); } }
</style>
