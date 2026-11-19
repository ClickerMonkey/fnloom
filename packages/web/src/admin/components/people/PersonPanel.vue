<script setup lang="ts">
/**
 * One person beside the People list: their role and whether they can sign in (both locked for the break-glass admin,
 * and for yourself), the providers they signed in through and when, and their groups (a group a provider syncs from its
 * claims says so: its next sign-in puts it back). Changes are emitted; the list's page makes them.
 */
import { ActorId, type PersonView, type SsoProviderView, type UserRole } from '@harness/core';
import { computed, ref } from 'vue';
import HubPicker from '../../../components/pickers/HubPicker.vue';
import { UiBanner, UiBadge, UiButton, UiSegmented, UiSkeleton, UiSwitch, fullTime, relativeTime, type SegmentOption } from '../../../ui/index.ts';

const props = defineProps<{
  person: PersonView | undefined;
  loading: boolean;
  problem: string;
  providers: readonly SsoProviderView[];
  /** Who is looking. */
  me: string | undefined;
  now: number;
  busy: boolean;
}>();
const emit = defineEmits<{ change: [change: { role?: UserRole; disabled?: boolean; group?: { id: ActorId; member: boolean } }]; retry: [] }>();

const ROLES: readonly SegmentOption<UserRole>[] = [{ value: 'member', label: 'Member', icon: 'user' }, { value: 'admin', label: 'Admin', icon: 'shield' }];
const picked = ref<readonly string[]>([]);

const locked = computed(() => props.person !== undefined && (props.person.breakGlass || props.person.id === props.me));
const lockReason = computed(() => (props.person?.breakGlass === true ? 'The break-glass admin always stays an admin who can sign in.' : 'You can’t take away your own role or sign-in.'));
const role = computed({ get: () => props.person?.role ?? 'member', set: (next: UserRole) => { if (next !== props.person?.role) emit('change', { role: next }); } });
const canSignIn = computed({ get: () => props.person?.disabled !== true, set: (on: boolean) => { emit('change', { disabled: !on }); } });
/** Providers that set roles at each sign-in, among the ones this person used. */
const managed = computed(() => {
  const used = new Set(props.person?.identities.map((i) => i.provider) ?? []);
  return props.providers.filter((p) => used.has(p.id) && (p.claims.admin.length > 0 || p.claims.member !== undefined)).map((p) => p.label);
});

function addGroups(ids: readonly string[]): void {
  for (const id of ids) {
    const group = ActorId.safeParse(id);
    if (group.success) emit('change', { group: { id: group.data, member: true } });
  }
  picked.value = [];
}
</script>

<template>
  <div class="person-panel" data-testid="person-panel">
    <UiBanner v-if="problem !== ''" tone="danger">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" icon="refresh" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <UiSkeleton v-if="person === undefined && loading" shape="lines" :lines="6" />
    <p v-else-if="person === undefined && problem === ''" class="none">Nobody here has that email.</p>
    <template v-if="person">
      <section class="block">
        <h3 class="heading">Role</h3>
        <UiSegmented v-model="role" :options="ROLES" label="Role" :class="{ locked }" :aria-disabled="locked || busy" />
        <p class="note">
          <template v-if="locked">{{ lockReason }}</template>
          <template v-else-if="managed.length > 0">{{ managed.join(' and ') }} sets the role again at each sign-in.</template>
          <template v-else>Admins can change the hub; members chat and use what they are allowed.</template>
        </p>
        <UiSwitch v-model="canSignIn" label="Can sign in" :description="person.disabled ? 'Signed out everywhere until turned back on.' : 'Turning this off signs them out everywhere at once.'" :disabled="locked || busy" />
      </section>

      <section class="block">
        <h3 class="heading">Signs in with</h3>
        <ul v-if="person.identities.length > 0 || person.password" class="ways">
          <li v-for="identity in person.identities" :key="identity.provider" class="way">
            <span class="way-name">{{ identity.label }}</span>
            <span class="way-detail">{{ identity.email ?? '' }}</span>
            <time class="way-at" :datetime="new Date(identity.lastSignInAt).toISOString()" :title="fullTime(identity.lastSignInAt)">{{ relativeTime(identity.lastSignInAt, now) }}</time>
          </li>
          <li v-if="person.password" class="way">
            <span class="way-name">{{ person.breakGlass ? 'Break-glass password' : 'Password' }}</span>
            <span class="way-detail">{{ person.breakGlass && providers.length > 0 ? 'For when a provider is down' : '' }}</span>
          </li>
        </ul>
        <p v-else class="note">Not signed in yet. {{ providers.length > 0 ? `Their first sign-in through ${providers.map((p) => p.label).join(' or ')} with ${person.email} links to them.` : 'They can sign in once a sign-in provider is configured.' }}</p>
      </section>

      <section class="block">
        <h3 class="heading">Groups</h3>
        <ul v-if="person.groups.length > 0" class="chips">
          <li v-for="group in person.groups" :key="group.id" class="chip">
            <span>{{ group.name }}</span>
            <UiBadge v-if="group.synced" title="A sign-in provider put them here from its claims">Synced</UiBadge>
            <button type="button" class="chip-x" :aria-label="`Take ${person.name} out of ${group.name}`" :disabled="busy" @click="emit('change', { group: { id: group.id, member: false } })">×</button>
          </li>
        </ul>
        <p v-else class="note">In no groups.</p>
        <p v-if="person.groups.some((g) => g.synced)" class="note">A synced group comes back at the next sign-in while the provider still names it.</p>
        <HubPicker v-model="picked" source="group" label="Add to a group" placeholder="Find a group" :disabled="busy" testid="person-add-group" @update:model-value="addGroups" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.person-panel { display: grid; gap: var(--space-5); }
.block { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.note, .none { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.locked { opacity: 0.6; pointer-events: none; }
.ways { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius-md); }
.way { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-3); align-items: baseline; padding: var(--space-2) var(--space-3); }
.way + .way { border-top: 1px solid var(--border); }
.way-name { font-weight: var(--weight-strong); }
.way-detail { min-width: 0; overflow: hidden; color: var(--text-dim); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.way-at { color: var(--text-faint); font-size: var(--text-xs); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.chip {
  display: inline-flex; align-items: center; gap: var(--space-1); padding: 2px 4px 2px var(--space-2); border: 1px solid var(--border);
  border-radius: var(--radius-full, 999px); background: var(--surface-2, var(--surface)); font-size: var(--text-sm);
  animation: ui-fade-in var(--medium) var(--ease);
}
.chip-x {
  display: inline-grid; place-items: center; width: 22px; height: 22px; border: 0; border-radius: 50%; background: transparent; color: var(--text-dim);
  cursor: pointer; transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease);
}
.chip-x:hover { background: var(--danger-soft, var(--border)); color: var(--danger); }
</style>
