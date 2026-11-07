/**
 * Contracts and rows the catalog, link and index tests share. The contracts are real SDK contracts, so the manifests
 * the tests import are exactly what systems send. Tests only.
 */
import {
  ActorId, SystemName, type FnDecl, type Manifest, type SystemRecord, type SystemStatus,
} from '@harness/core';
import { context, embedder, fn, g, kind, manifestOf, mention, sectioner, system, type, type AnyContract } from '@harness/sdk';

/** The admin actor tests act as. */
export const ADMIN = ActorId.parse('act_admin');

/** A shop: a named type with a method, a kind, fns and context. */
export const shop = system('shop', { description: 'A small shop.' }).with({
  config: g.obj({ currency: g.text({ minLength: 3, maxLength: 3 }) }),
  types: {
    Product: type({
      description: 'A product for sale.',
      shape: g.obj({ sku: g.text(), price: g.num({ min: 0 }) }),
      display: { label: 'Product', title: 'sku' },
      methods: { discount: fn({ description: 'Take some off.', args: g.obj({ percent: g.num() }), returns: g.num() }) },
    }),
  },
  kinds: { report: kind({ description: 'A report over sales.', applicability: 'When someone wants numbers.', payload: g.obj({ query: g.text() }) }) },
  fns: {
    get: fn({ description: 'Get a product by its sku.', args: g.obj({ sku: g.text() }), returns: g.text(), tags: ['read'] }),
    list: fn({ description: 'List every product.', args: g.obj({}), returns: g.list(g.text()), tags: ['read'] }),
  },
  context: { guide: context({ description: 'How the shop works.', content: 'Use @shop/get to find one, see @shop/guide.' }) },
  mentions: { products: mention({ title: 'Products', description: 'Products by sku.', target: g.obj({ sku: g.text() }) }) },
  sectioners: { csv: sectioner({ description: 'One section per row.', match: { format: 'csv' } }) },
});

/** Orders: depends on shop's fns and types. */
export const orders = system('orders', { description: 'Orders.' }).with({
  fns: {
    place: fn({ description: 'Place an order.', args: g.obj({ product: shop.types.Product, count: g.num() }), returns: g.bool(), deps: { get: shop.fns.get } }),
    sales: shop.kinds.report.fn({ description: 'Sales this week.', payload: { query: 'week' } }),
  },
});

/** The embedder system's shape, small. */
export const vectors = system('vectors', { description: 'Embeddings.' }).with({
  embedders: {
    document: embedder({ dimensions: 3, maxInput: 100, pricePerMillionTokens: 0 }),
    query: embedder({ dimensions: 3, maxInput: 100, pricePerMillionTokens: 0 }),
  },
});

/** A contract's manifest. */
export function manifestFor(contract: AnyContract, version = '1.0.0'): Promise<Manifest> {
  return manifestOf(contract, { version, resources: false });
}

/** A fn declaration from a manifest, by local name. */
export function declOf(manifest: Manifest, name: string): FnDecl {
  const decl = manifest.fns.find((f) => f.name === name);
  if (decl === undefined) { throw new Error(`no fn ${name}`); }
  return decl;
}

/** A system row in a given status. */
export function systemRow(name: string, status: SystemStatus, extra: Partial<SystemRecord> = {}): SystemRecord {
  return {
    name: SystemName.parse(name),
    description: `${name} system`,
    status,
    enabled: { functions: true, renderers: true },
    keyFingerprint: `fp-${name}`,
    publicKey: `pk-${name}`,
    version: '1.0.0',
    manifestHash: '',
    actor: ActorId.parse(`act_${name}`),
    ...extra,
  };
}
