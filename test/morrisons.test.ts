import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  MorrisonsProvider,
  normaliseProduct,
  parseSearchResponse,
  parseUnitPrice,
  productsFromRows,
} from '../src/providers/morrisons';

const fixture = () =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'morrisons-search.json'), 'utf8'));

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

function product(n: number) {
  return {
    productId: `uuid-${n}`,
    retailerProductId: String(100000000 + n),
    name: `Product ${n}`,
    available: true,
    price: { amount: '1.00', currency: 'GBP' },
  };
}

/** A provider whose HTTP layer serves canned pages keyed by page token. */
function stubbed(pages: Record<string, { rows: any[]; next?: string }>) {
  const provider = new MorrisonsProvider();
  const calls: Array<{ token?: string; size: number }> = [];
  (provider as any).http.get = async (_url: string, opts: any) => {
    const token = opts.params.pageToken as string | undefined;
    calls.push({ token, size: opts.params.maxPageSize });
    const page = pages[token ?? 'first'];
    return {
      data: {
        productGroups: [{ type: 'cluster', decoratedProducts: page?.rows ?? [] }],
        metadata: page?.next ? { nextPageToken: page.next } : {},
      },
    };
  };
  return { provider, calls };
}

async function main() {
  console.log('morrisons provider');

  await check('maps a decorated product onto the shared shape', () => {
    const [milk] = productsFromRows(parseSearchResponse(fixture()).rows);
    assert.deepStrictEqual(milk, {
      product_uid: '100000001',
      name: 'Morrisons Semi Skimmed Milk 4 Pint',
      retail_price: { price: 1.75 },
      in_stock: true,
      provider: 'morrisons',
      unit_price: { measure: 'litre', price: 0.77 },
      image_url: 'https://groceries.morrisons.com/images-v3/test/100000001/300x300.jpg',
      size: '2.272L',
      rating: 3.2,
      review_count: 24,
      shelf_life_days: 7,
    });
  });

  await check('keeps the regular shelf price rather than a promotional one', () => {
    const [milk] = productsFromRows(parseSearchResponse(fixture()).rows);
    assert.strictEqual(milk.retail_price.price, 1.75);
  });

  await check('converts pence (GBX) unit prices to pounds and keeps GBP ones', () => {
    assert.deepStrictEqual(
      parseUnitPrice({ price: { amount: '77.0', currency: 'GBX' }, unit: 'fop.price.per.litre' }),
      { measure: 'litre', price: 0.77 }
    );
    assert.deepStrictEqual(
      parseUnitPrice({ price: { amount: '5.33', currency: 'GBP' }, unit: 'fop.price.per.kg' }),
      { measure: 'kg', price: 5.33 }
    );
    assert.deepStrictEqual(
      parseUnitPrice({ price: { amount: '15.6', currency: 'GBX' }, unitName: 'PER_EACH' }),
      { measure: 'each', price: 0.156 }
    );
  });

  await check('drops a unit price in an unknown currency instead of guessing', () => {
    assert.strictEqual(
      parseUnitPrice({ price: { amount: '15.6', currency: 'XYZ' }, unit: 'fop.price.per.each' }),
      undefined
    );
  });

  await check('preserves explicit unavailability and unknown availability', () => {
    const products = productsFromRows(parseSearchResponse(fixture()).rows);
    assert.strictEqual(products[1].in_stock, false);
    assert.strictEqual(products[2].in_stock, null);
  });

  await check('missing price is null, never 0', () => {
    const products = productsFromRows(parseSearchResponse(fixture()).rows);
    assert.strictEqual(products[2].retail_price.price, null);
    assert.strictEqual(
      normaliseProduct({ retailerProductId: '1', name: 'x', price: { amount: '2.00', currency: 'EUR' } }).retail_price.price,
      null
    );
  });

  await check('a rating with no reviews behind it is left out', () => {
    const products = productsFromRows(parseSearchResponse(fixture()).rows);
    assert.strictEqual(products[1].rating, undefined);
    assert.strictEqual(products[1].review_count, undefined);
  });

  await check('drops duplicates across groups and skips malformed rows', () => {
    const products = productsFromRows(parseSearchResponse(fixture()).rows);
    assert.deepStrictEqual(products.map((p) => p.product_uid), ['100000001', '100000002', '100000003']);
  });

  await check('rejects a response where every row is malformed', () => {
    assert.throws(() => productsFromRows([{ name: 'no id' }, { retailerProductId: 'abc', name: 'bad id' }]), /none could be read/);
  });

  await check('a well-formed empty result is []', () => {
    assert.deepStrictEqual(parseSearchResponse({ productGroups: [], metadata: {} }), { rows: [], nextPageToken: undefined });
    assert.deepStrictEqual(productsFromRows([]), []);
  });

  await check('rejects a malformed top-level response', () => {
    assert.throws(() => parseSearchResponse('<html>'), /unexpected search response/);
    assert.throws(() => parseSearchResponse({ error: 'x' }), /unexpected search response/);
    assert.throws(() => parseSearchResponse({ productGroups: [null] }), /malformed product group/);
  });

  await check('rejects an empty query before any HTTP request', async () => {
    const { provider, calls } = stubbed({});
    await assert.rejects(() => provider.search('   '), /query must not be empty/);
    assert.strictEqual(calls.length, 0);
  });

  await check('rejects category filtering and invalid limit/offset', async () => {
    const { provider } = stubbed({});
    await assert.rejects(() => provider.search('milk', { category: 'Dairy' }), /not implemented/);
    await assert.rejects(() => provider.search('milk', { limit: -1 }), /limit/);
    await assert.rejects(() => provider.search('milk', { offset: 1.5 }), /offset/);
    assert.deepStrictEqual(await provider.search('milk', { limit: 0 }), []);
  });

  await check('applies limit and offset within one page, sized to what was asked', async () => {
    const { provider, calls } = stubbed({ first: { rows: [1, 2, 3, 4, 5, 6, 7, 8].map(product), next: 't2' } });
    const products = await provider.search('milk', { offset: 2, limit: 3 });
    assert.deepStrictEqual(products.map((p) => p.name), ['Product 3', 'Product 4', 'Product 5']);
    assert.deepStrictEqual(calls, [{ token: undefined, size: 5 }]);
  });

  await check('follows page tokens and stops when they run out', async () => {
    const { provider, calls } = stubbed({
      first: { rows: [1, 2].map(product), next: 't2' },
      t2: { rows: [3, 4].map(product), next: 't3' },
      t3: { rows: [5].map(product) },
    });
    const products = await provider.search('milk', { limit: 10 });
    assert.strictEqual(products.length, 5);
    assert.deepStrictEqual(calls.map((c) => c.token), [undefined, 't2', 't3']);
  });

  await check('terminates on a repeated token or a fully overlapping page', async () => {
    const looping = stubbed({ first: { rows: [1].map(product), next: 'same' }, same: { rows: [2].map(product), next: 'same' } });
    assert.strictEqual((await looping.provider.search('milk', { limit: 50 })).length, 2);
    assert.strictEqual(looping.calls.length, 2);

    const overlapping = stubbed({ first: { rows: [1, 2].map(product), next: 't2' }, t2: { rows: [1, 2].map(product), next: 't3' } });
    assert.strictEqual((await overlapping.provider.search('milk', { limit: 50 })).length, 2);
    assert.strictEqual(overlapping.calls.length, 2);
  });

  await check('propagates HTTP errors with provider context, hinting at bot protection on 403', async () => {
    const provider = new MorrisonsProvider();
    (provider as any).http.get = async () => {
      const error: any = new Error('Request failed with status code 403');
      error.response = { status: 403 };
      error.isAxiosError = true;
      throw error;
    };
    await assert.rejects(() => provider.search('milk'), /Morrisons search failed \(HTTP 403\).*bot protection/);
  });

  await check('getProduct validates ids and maps the detail payload', async () => {
    const provider = new MorrisonsProvider();
    await assert.rejects(() => provider.getProduct('not-a-number'), /numeric retailer product ids/);
    let asked: any;
    (provider as any).http.get = async (url: string, opts: any) => {
      asked = { url, id: opts.params.retailerProductId };
      return { data: { product: fixture().productGroups[0].decoratedProducts[0], bopData: {} } };
    };
    const p = await provider.getProduct(' 100000001 ');
    assert.deepStrictEqual(asked, { url: '/api/webproductpagews/v5/products/bop', id: '100000001' });
    assert.strictEqual(p.name, 'Morrisons Semi Skimmed Milk 4 Pint');
  });

  await check('getProduct reports an unknown id clearly', async () => {
    const provider = new MorrisonsProvider();
    (provider as any).http.get = async () => {
      const error: any = new Error('Request failed with status code 404');
      error.response = { status: 404 };
      error.isAxiosError = true;
      throw error;
    };
    await assert.rejects(() => provider.getProduct('999'), /no product with id 999/);
  });

  await check('registry declares anonymous search only', async () => {
    const { getManifest, createProvider } = await import('../src/providers/registry');
    const manifest = getManifest('morrisons');
    assert.deepStrictEqual(manifest.capabilities, ['search']);
    assert.strictEqual(manifest.auth, 'none');
    assert.strictEqual(manifest.country, 'GB');
    assert.strictEqual(manifest.session, undefined);
    assert.strictEqual((await createProvider('morrisons')).name, 'morrisons');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
