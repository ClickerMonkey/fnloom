<script setup lang="ts">
/** Nothing lives at this address: say so, and offer the way back. */
import { useRouter } from 'vue-router';
import { links } from '../app/routes.ts';
import { UiButton, UiEmpty } from '../ui/index.ts';

const router = useRouter();
</script>

<template>
  <div class="wrap">
    <UiEmpty icon="search" title="Nothing here" body="The page you were looking for isn't at this address.">
      <template #actions>
        <UiButton variant="primary" icon="arrow-right" @click="router.push(links.chat())">Go to chat</UiButton>
      </template>
    </UiEmpty>
  </div>
</template>

<style scoped>
.wrap { min-height: 100%; display: grid; place-items: center; padding: var(--space-5); }
</style>
