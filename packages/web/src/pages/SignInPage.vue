<script setup lang="ts">
/** Sign in, or make the admin account on a new hub. Returns to the page that sent you here. */
import { onMounted, reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ROUTES } from '../router.ts';
import { useSignIn } from '../state/signIn.ts';

const { setup, busy, problem, load, submit } = useSignIn();
const form = reactive({ email: '', password: '', name: '' });
const route = useRoute();
const router = useRouter();

onMounted(() => { void load(); });

async function onSubmit(): Promise<void> {
  if (await submit(form)) {
    const next = route.query['next'];
    await router.replace(typeof next === 'string' && next.startsWith('/') ? next : { name: ROUTES.chat });
  }
}
</script>

<template>
  <div class="wrap">
    <form class="card" @submit.prevent="onSubmit">
      <h1>{{ setup?.needsAdmin ? 'Make the admin account' : 'Sign in' }}</h1>
      <label v-if="setup?.needsAdmin">Name <input v-model="form.name" autocomplete="name" required /></label>
      <label>Email <input v-model="form.email" type="email" autocomplete="email" required /></label>
      <label>Password <input v-model="form.password" type="password" :autocomplete="setup?.needsAdmin ? 'new-password' : 'current-password'" required /></label>
      <p v-if="problem" class="problem" role="alert">{{ problem }}</p>
      <button type="submit" :disabled="busy">{{ busy ? 'One moment…' : setup?.needsAdmin ? 'Create and sign in' : 'Sign in' }}</button>
    </form>
  </div>
</template>

<style scoped>
.wrap { min-height: 100%; display: grid; place-items: center; padding: var(--space-5); }
.card { width: min(380px, 100%); display: grid; gap: var(--space-4); padding: var(--space-6); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
label { display: grid; gap: var(--space-1); color: var(--text-dim); font-size: 13px; }
input { padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
button { padding: var(--space-3); border: 0; border-radius: var(--radius); background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; transition: opacity var(--fast) var(--ease); }
button:disabled { opacity: 0.6; cursor: default; }
.problem { margin: 0; color: var(--danger); font-size: 13px; }
</style>
