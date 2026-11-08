<script setup lang="ts">
/** The design gallery's gin section: the type, value and expression editors, each beside its viewer, sharing one value. */
import type { ExprDef } from '@aeye/gin';
import type { GinTypeDef, Json } from '@harness/core';
import { shallowRef } from 'vue';
import GinExprView from '../../gin/GinExprView.vue';
import GinTypeView from '../../gin/GinTypeView.vue';
import GinValueView from '../../gin/GinValueView.vue';
import { UiCard } from '../../ui/index.ts';
import { SAMPLE_EXPR, SAMPLE_SCOPE, SAMPLE_TYPE, SAMPLE_VALUE } from './samples.ts';

const type = shallowRef<GinTypeDef | undefined>(SAMPLE_TYPE);
const value = shallowRef<Json>(SAMPLE_VALUE);
const expr = shallowRef<ExprDef | undefined>(SAMPLE_EXPR);
</script>

<template>
  <div class="design-gin" data-testid="design-gin">
    <UiCard title="Value: editor" subtitle="An input for every gin type, nested, checked live by gin.">
      <GinValueView v-model="value" :type="type" label="Read" data-testid="design-value-edit" />
    </UiCard>
    <UiCard title="Value: viewer" subtitle="The same value, read only.">
      <GinValueView :model-value="value" :type="type" readonly label="Read" data-testid="design-value-view" />
    </UiCard>
    <UiCard title="Type: editor" subtitle="Add, rename, reorder and remove fields; change kinds and options.">
      <GinTypeView v-model="type" label="Read args" data-testid="design-type-edit" />
    </UiCard>
    <UiCard title="Type: viewer">
      <GinTypeView :model-value="type" readonly label="Read args" data-testid="design-type-view" />
    </UiCard>
    <UiCard title="Expression: editor" subtitle="Every node kind gin has, with what it evaluates to.">
      <GinExprView v-model="expr" :scope="SAMPLE_SCOPE" label="Label" data-testid="design-expr-edit" />
    </UiCard>
    <UiCard title="Expression: viewer">
      <GinExprView :model-value="expr" :scope="SAMPLE_SCOPE" readonly label="Label" data-testid="design-expr-view" />
    </UiCard>
  </div>
</template>

<style scoped>
.design-gin { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: var(--space-4); align-items: start; }
</style>
