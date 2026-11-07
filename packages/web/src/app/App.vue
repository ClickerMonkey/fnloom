<script setup lang="ts">
/** The root: the shell, which draws the current page, with the browser's named gin types for every form in it. */
import { provide } from 'vue';
import { FORM_TYPES } from '../chat/forms/types.ts';
import { useStores } from '../state/stores.ts';
import AppShell from './AppShell.vue';

provide(FORM_TYPES, useStores().chat.types);
</script>

<template>
  <AppShell />
</template>
