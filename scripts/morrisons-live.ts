/**
 * Opt-in live smoke test. It is intentionally not part of `npm test`: retailer
 * catalogues, counts and prices are dynamic.
 *
 * Run with: npm run test:morrisons:live
 */

import assert from 'node:assert';
import { MorrisonsProvider } from '../src/providers/morrisons';

async function main() {
  const provider = new MorrisonsProvider();

  for (const query of ['semi skimmed milk', 'chicken breast fillets']) {
    const products = await provider.search(query, { limit: 5 });
    assert.ok(products.length > 0, `${query}: expected at least one result`);
    for (const product of products) {
      assert.match(product.product_uid, /^\d+$/, `${query}: product_uid is not a retailer product id`);
      assert.ok(product.name, `${query}: name is missing`);
      assert.ok(product.retail_price.price === null || product.retail_price.price > 0, `${query}: price is invalid`);
      if (product.unit_price) {
        // Pence would show up as values like 77.0 per litre; pounds keep it sensible.
        assert.ok(product.unit_price.price > 0 && product.unit_price.price < 100, `${query}: unit price looks unnormalised`);
      }
    }
    console.log(`✓ ${query}: ${products.length} live results, first: ${products[0].name} £${products[0].retail_price.price}`);
  }

  const paged = await provider.search('milk', { offset: 5, limit: 5 });
  const firstTen = await provider.search('milk', { limit: 10 });
  assert.deepStrictEqual(
    paged.map((p) => p.product_uid),
    firstTen.slice(5).map((p) => p.product_uid),
    'offset should match the same slice of a larger search'
  );
  console.log('✓ milk: offset/limit agree with a larger search');

  const lookedUp = await provider.getProduct(firstTen[0].product_uid);
  assert.strictEqual(lookedUp.product_uid, firstTen[0].product_uid);
  console.log(`✓ getProduct(${lookedUp.product_uid}): ${lookedUp.name}`);

  const missing = await provider.search('zzqxjv-no-such-product-12345', { limit: 5 });
  assert.strictEqual(missing.length, 0, 'nonexistent query should have no results');
  console.log('✓ nonsense query: 0 live results');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
