/**
 * HTTPS on the hub's port (`hub/src/api/https.ts`): whether it is on, where its certificate comes from (the hub's own
 * authority, or certificate files an admin gave it), and what a device needs to use it: the authority to install, its
 * fingerprint to compare, and the `https://` link for each address of the hub's computer.
 */
import { z } from 'zod';
import { ActorId, Timestamp } from './primitives.ts';

/** The hub option key of the HTTPS switch (an admin's choice; `HARNESS_HTTPS` until one is made). */
export const HTTPS_OPTION = 'https';

/** Where the hub serves its authority's certificate, for a phone or computer to install. */
export const AUTHORITY_PATHS = { der: '/harness-ca.crt', pem: '/harness-ca.pem' } as const;

/** Where the certificate comes from: the hub's own authority, or the files in `HARNESS_TLS_CERT` / `HARNESS_TLS_KEY`. */
export const HttpsSource = z.enum(['own', 'files']);
export type HttpsSource = z.infer<typeof HttpsSource>;

/** HTTPS as people see it. */
export const HttpsView = z.object({
  on: z.boolean(),
  source: HttpsSource,
  /** Who switched it and when (nothing: the environment's default). */
  setBy: ActorId.optional(),
  updatedAt: Timestamp.optional(),
  /** The hub's own authority's SHA-256 fingerprint, once made (own certificates only). */
  fingerprint: z.string().optional(),
  /** The hub's own authority's name, as a phone lists it among its certificates. */
  authorityName: z.string().optional(),
  /** This computer's name, as the certificate carries it. */
  host: z.string(),
  /** The hub's address on each network of its computer, over https (empty while off). */
  links: z.array(z.string()),
});
export type HttpsView = z.infer<typeof HttpsView>;
