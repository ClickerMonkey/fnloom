<script setup lang="ts">
/**
 * Settings › App › "Use it on your phone": how a phone (or another computer) gets the hub's secure address, which
 * installing the app and notifications need. With the hub's own certificate: install the hub's authority (a QR code
 * and a link to download it, then the iPhone or Android steps to trust it), open the secure address (a QR code per
 * network), then install. With a certificate the hub was given, only the secure address. Off: who can turn it on.
 */
import type { HttpsView } from '@harness/core';
import { computed } from 'vue';
import { plainTwin } from '../state/https.ts';
import { UiBanner, UiCard, UiIcon, UiSpinner } from '../ui/index.ts';
import QrCode from './QrCode.vue';

const props = defineProps<{
  view: HttpsView | undefined;
  /** The authority's download path, when the hub has one of its own and https is on. */
  authority: string | undefined;
  loading: boolean;
  problem: string;
}>();

/** The address the QR codes point at: the first network's. */
const first = computed(() => props.view?.links[0]);
/** Where a phone downloads the authority: plain http on the same address (it can't trust https before it has it). */
const download = computed(() => (props.authority === undefined || first.value === undefined ? undefined : plainTwin(first.value, props.authority)));
</script>

<template>
  <UiCard title="Use it on your phone" subtitle="Your phone needs the hub’s secure address to install the app and get notifications." data-testid="phone-card">
    <UiSpinner v-if="loading && view === undefined" />
    <UiBanner v-else-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    <p v-else-if="view !== undefined && !view.on" class="dim" data-testid="https-off">The hub’s secure address is off. An admin can turn it on in Settings › Hub.</p>
    <ol v-else-if="view !== undefined" class="steps">
      <li v-if="authority !== undefined" data-testid="phone-authority">
        <h3>Trust the hub on your phone</h3>
        <p class="dim">Scan this with your phone’s camera, or open the link on the phone, to download the hub’s certificate. You do this once per phone.</p>
        <div class="row">
          <QrCode v-if="download !== undefined" :text="download" label="QR code to download the hub's certificate" />
          <div class="how">
            <a :href="authority" download class="download" data-testid="download-authority"><UiIcon name="download" :size="16" />Download the certificate</a>
            <p><strong>iPhone or iPad:</strong> allow the download, then open Settings › Profile Downloaded › Install. Then go to Settings › General › About › Certificate Trust Settings and turn on full trust for “{{ view.authorityName ?? view.host }}”.</p>
            <p><strong>Android:</strong> open the download, or go to Settings › Security › More security › Encryption &amp; credentials › Install a certificate › CA certificate, and pick it.</p>
            <p v-if="view.fingerprint !== undefined" class="dim small">Its fingerprint, if you want to check it: <code>{{ view.fingerprint }}</code></p>
          </div>
        </div>
      </li>
      <li data-testid="phone-address">
        <h3>Open the secure address</h3>
        <p v-if="view.links.length === 0" class="dim">This computer isn’t on a network other devices can reach.</p>
        <div v-else class="row">
          <QrCode v-if="first !== undefined" :text="first" label="QR code of the hub's secure address" />
          <div class="how">
            <p class="dim">On your phone, on the same Wi-Fi (or Tailscale):</p>
            <ul class="links">
              <li v-for="link in view.links" :key="link"><a :href="link" data-testid="https-link">{{ link }}</a></li>
            </ul>
          </div>
        </div>
      </li>
      <li>
        <h3>Install the app</h3>
        <p class="dim"><strong>iPhone or iPad:</strong> in Safari, tap Share, then Add to Home Screen. <strong>Android:</strong> in Chrome, open the menu and tap Install app.</p>
      </li>
    </ol>
  </UiCard>
</template>

<style scoped>
.steps { display: grid; gap: var(--space-5); margin: 0; padding-left: var(--space-5); }
h3 { margin: 0 0 var(--space-1); font-size: var(--text-md, 1rem); font-weight: var(--weight-strong); }
.steps p { margin: 0 0 var(--space-2); }
.row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-4); margin-top: var(--space-2); }
.how { flex: 1; min-width: min(100%, 260px); }
.links { margin: 0; padding-left: var(--space-4); overflow-wrap: anywhere; }
.dim { color: var(--text-dim); }
.small { font-size: var(--text-xs); }
code { overflow-wrap: anywhere; }
.download {
  display: inline-flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); font-weight: var(--weight-medium); text-decoration: none;
}
.download:hover { background: var(--surface-2); text-decoration: none; }
.download:focus-visible { outline: none; box-shadow: var(--ring); }
</style>
