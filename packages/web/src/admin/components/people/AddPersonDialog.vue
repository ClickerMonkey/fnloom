<script setup lang="ts">
/**
 * Add a person by their email (an invite): their name, role and groups. The form's checks are the hub's own (the
 * `addUser` body). With sign-in providers configured, their first sign-in through one with this email (verified by the
 * provider) links to them; without one, the dialog says they can't sign in yet.
 */
import { ActorId, hubWebSpec, type SsoProviderView, type UserRole } from '@harness/core';
import { computed, reactive, ref, watch } from 'vue';
import HubPicker from '../../../components/pickers/HubPicker.vue';
import { checkForm } from '../../../state/problems.ts';
import { UiBanner, UiButton, UiDialog, UiInput, UiSegmented, type SegmentOption } from '../../../ui/index.ts';
import type { NewPerson } from '../../state/people.ts';

const props = withDefaults(defineProps<{ providers: readonly SsoProviderView[]; busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [person: NewPerson] }>();

const ROLES: readonly SegmentOption<UserRole>[] = [{ value: 'member', label: 'Member', icon: 'user' }, { value: 'admin', label: 'Admin', icon: 'shield' }];
const draft = reactive<{ name: string; email: string; role: UserRole; groups: readonly string[] }>({ name: '', email: '', role: 'member', groups: [] });
const tried = ref(false);
const checked = computed(() => checkForm(hubWebSpec.endpoints.addUser.cfg.body, { name: draft.name.trim(), email: draft.email.trim(), role: draft.role }));
const errorOf = (field: 'name' | 'email'): string => {
  if (!tried.value) return '';
  if (field === 'name' && draft.name.trim() === '') return 'Give their name.';
  return checked.value.ok ? '' : checked.value.problems[field] ?? '';
};
const how = computed(() => (props.providers.length === 0
  ? 'No sign-in provider is configured yet, so they can’t sign in until one is (HARNESS_SSO_PROVIDERS).'
  : `They sign in through ${props.providers.map((p) => p.label).join(' or ')} with this email; the provider must vouch for it.`));

watch(open, (isOpen) => { if (isOpen) { Object.assign(draft, { name: '', email: '', role: 'member', groups: [] }); tried.value = false; } });

function save(): void {
  tried.value = true;
  const read = checked.value;
  if (!read.ok || draft.name.trim() === '') return;
  const groups = draft.groups.flatMap((id) => { const group = ActorId.safeParse(id); return group.success ? [group.data] : []; });
  emit('save', { name: read.value.name, email: read.value.email, role: read.value.role, ...(groups.length === 0 ? {} : { groups }) });
}
</script>

<template>
  <UiDialog v-model:open="open" title="Add a person" :description="how" width="520px">
    <form class="form" novalidate data-testid="add-person-form" @submit.prevent="save">
      <div class="grid">
        <UiInput v-model="draft.name" label="Name" name="name" autocomplete="off" required :error="errorOf('name')" autofocus />
        <UiInput v-model="draft.email" label="Email" name="email" type="email" autocomplete="off" required :error="errorOf('email')" />
      </div>
      <div class="field">
        <span class="label">Role</span>
        <UiSegmented v-model="draft.role" :options="ROLES" label="Role" />
      </div>
      <HubPicker v-model="draft.groups" source="group" label="Groups" placeholder="Find groups" hint="Optional." testid="add-person-groups" />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="add-person-save" @click="save">Add person</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); align-items: start; gap: var(--space-3); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
</style>
