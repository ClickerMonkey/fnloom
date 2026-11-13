<script setup lang="ts">
/**
 * How a remote service is signed in to (`RemoteAuth`): none, a token, headers or OAuth, each shared (typed here,
 * sealed by the hub) or per person (each person connects on the connections page). A kept secret reads as kept; a
 * blank token or client secret keeps it, and header values are replaced as a whole. Problems come by config path
 * (`auth.token`). `kinds` narrows the ways offered (an API service has no OAuth).
 */
import type { RemoteAuthPer } from '@harness/core';
import { computed } from 'vue';
import { UiChipInput, UiInput, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { AUTH_WORDS, PER_WORDS, type AuthDraft, type PairRow, type RemoteAuthKind } from '../logic/remote-config.ts';
import type { PathProblems } from '../../state/problems.ts';
import PairRowsEditor from './PairRowsEditor.vue';

const props = withDefaults(defineProps<{ problems?: PathProblems; kinds?: readonly RemoteAuthKind[] }>(), { problems: () => ({}), kinds: () => ['none', 'bearer', 'headers', 'oauth'] });
const auth = defineModel<AuthDraft>({ required: true });

const kindOptions = computed((): SegmentOption<RemoteAuthKind>[] => props.kinds.map((kind) => ({ value: kind, label: AUTH_WORDS[kind].label })));
const PERS: readonly SegmentOption<RemoteAuthPer>[] = (['shared', 'person'] as const).map((per) => ({ value: per, label: PER_WORDS[per].label }));

const kind = computed({ get: () => auth.value.kind, set: (next: RemoteAuthKind) => { auth.value = { ...auth.value, kind: next }; } });
const per = computed({ get: () => auth.value.per, set: (next: RemoteAuthPer) => { auth.value = { ...auth.value, per: next }; } });
const shared = computed(() => auth.value.per === 'shared');
const keeps = (field: 'token' | 'values' | 'clientSecret'): boolean => auth.value.kept.includes(field);
const perAbout = computed(() => (auth.value.kind === 'oauth' ? PER_WORDS[auth.value.per].oauth : PER_WORDS[auth.value.per].about));

function set(field: 'token' | 'clientId' | 'clientSecret', text: string): void {
  auth.value = { ...auth.value, [field]: text };
}
function setHeaders(rows: readonly PairRow[]): void {
  auth.value = { ...auth.value, headers: rows };
}
function setScopes(scopes: readonly string[]): void {
  auth.value = { ...auth.value, scopes };
}
/** Type new header values: the kept ones are dropped on save. */
function replaceValues(): void {
  auth.value = { ...auth.value, kept: auth.value.kept.filter((field) => field !== 'values'), headers: auth.value.headers.map((row) => ({ ...row, value: '' })) };
}
const readScope = (text: string): string | undefined => (text.trim() === '' ? undefined : text.trim());
</script>

<template>
  <fieldset class="auth" data-testid="remote-auth">
    <legend class="label">Sign-in</legend>
    <UiSegmented v-model="kind" :options="kindOptions" label="Sign-in" data-testid="auth-kind" />
    <p class="hint">{{ AUTH_WORDS[kind].about }}</p>
    <template v-if="kind !== 'none'">
      <UiSegmented v-model="per" :options="PERS" label="Whose credentials" data-testid="auth-per" />
      <p class="hint">{{ perAbout }}</p>
    </template>

    <UiInput
      v-if="kind === 'bearer' && shared" :model-value="auth.token" label="Token" type="password" revealable autocomplete="off"
      :placeholder="keeps('token') ? 'Kept; type a new one to replace it' : ''" :required="!keeps('token')" :error="problems['auth.token'] ?? ''"
      data-testid="auth-token" @update:model-value="set('token', $event)"
    />
    <PairRowsEditor
      v-if="kind === 'headers'" :rows="auth.headers" label="Headers" name-placeholder="X-Api-Key" value-placeholder="Value" secret
      :names-only="!shared" :kept="shared && keeps('values')" :hint="shared ? 'Sealed by the hub once saved.' : 'Each person types these values when they connect.'"
      :error="problems['auth.names'] ?? problems['auth.values'] ?? ''" testid="auth-headers" @update:rows="setHeaders" @replace="replaceValues"
    />
    <template v-if="kind === 'oauth'">
      <UiChipInput
        :model-value="auth.scopes" label="Scopes" placeholder="read write" hint="Enter adds one. None asks for what the server says it supports."
        :read="readScope" refusal="Type a scope." @update:model-value="setScopes"
      />
      <div class="pair">
        <UiInput :model-value="auth.clientId" label="Client ID" hint="Blank: the hub registers itself with the server." :error="problems['auth.clientId'] ?? ''" @update:model-value="set('clientId', $event)" />
        <UiInput
          :model-value="auth.clientSecret" label="Client secret" type="password" revealable :disabled="auth.clientId.trim() === ''"
          :placeholder="keeps('clientSecret') ? 'Kept; type to replace' : 'For a confidential client'" :error="problems['auth.clientSecret'] ?? ''"
          @update:model-value="set('clientSecret', $event)"
        />
      </div>
    </template>
    <p v-if="problems['auth'] !== undefined" class="error" role="alert">{{ problems['auth'] }}</p>
  </fieldset>
</template>

<style scoped>
.auth { display: grid; gap: var(--space-2); min-width: 0; margin: 0; padding: 0; border: 0; }
.label { padding: 0; margin-bottom: var(--space-1); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0 0 var(--space-1); color: var(--text-faint); font-size: var(--text-xs); }
.error { margin: 0; color: var(--danger); font-size: var(--text-xs); }
.pair { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); }
</style>
