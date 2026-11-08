<script setup lang="ts">
/** The root: the shell, which draws the current page, with the browser's named gin types for every form in it. */
import { provide } from 'vue';
import { FORM_TYPES } from '../chat/forms/types.ts';
import { useStores } from '../state/stores.ts';
import AppShell from './AppShell.vue';
import { useLeaveWhenSignedOut } from './signOut.ts';

provide(FORM_TYPES, useStores().chat.types);
useLeaveWhenSignedOut();
</script>

<template>
  <AppShell />
</template>
