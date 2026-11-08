/**
 * Morrisons (UK) — anonymous catalogue search.
 *
 * groceries.morrisons.com runs on the Ocado Smart Platform, so it serves the
 * same internal web-product-page JSON service that ocado.ts documents:
 *
 *   GET /api/webproductpagews/v6/product-pages/search?q=…        search, token-paged
 *   GET /api/webproductpagews/v5/products/bop?retailerProductId=…  product detail
 *
 * Both answer without cookies, login or a browser (verified live 2026-11-08).
 *
 * Product identity: `product_uid` is Morrisons' numeric retailer product id —
 * the one in /products/<slug>/<id> URLs — because that is what product lookup
 * accepts without a session. The UUID-keyed `PUT /v6/products` lookup ocado.ts
 * uses returns 403 here without one.
 *
 * Pricing: `retail_price` is the shelf price the API reports. Price-drop offers
 * ("Now £1.75, Was £2.40") arrive as promotions alongside it and are not
 * substituted. Unit prices are reported in GBP on some lines and in pence (GBX)
 * on others; both are normalised to pounds, and any other currency is dropped
 * rather than guessed.
 *
 * Out of scope here: basket, slots, checkout and orders. Login is bot-protected,
 * so those would need an imported browser session and belong in a follow-up.
 */

import axios, { AxiosInstance } from 'axios';
import type { GroceryProvider, Product, SearchOptions } from './types';
import { toPrice, toStock } from './normalise';
import { shelfLifeDays } from './ocado';

export const MORRISONS_BASE = 'https://groceries.morrisons.com';
const SEARCH_PATH = '/api/webproductpagews/v6/product-pages/search';
const PRODUCT_PATH = '/api/webproductpagews/v5/products/bop';

/** The storefront's own page size ceiling. */
export const MORRISONS_MAX_PAGE_SIZE = 300;
/** Guard against an upstream token loop. 20 × 300 is far beyond any real query. */
const MAX_PAGES = 20;

export interface SearchPage {
  rows: any[];
  nextPageToken?: string;
}

/** `{ price: { amount: "77.0", currency: "GBX" }, unit: "fop.price.per.litre" }` → `{ measure: "litre", price: 0.77 }` */
export function parseUnitPrice(raw: any): Product['unit_price'] {
  const amount = toPrice(raw?.price?.amount);
  if (amount === null) return undefined;

  const currency = String(raw?.price?.currency ?? '').toUpperCase();
  let price: number;
  if (currency === 'GBP') price = amount;
  else if (currency === 'GBX') price = Math.round(amount * 100) / 10_000; // pence → pounds, 4 dp
  else return undefined;

  const unit = String(raw?.unit ?? '');
  const measure = unit.startsWith('fop.price.per.')
    ? unit.slice('fop.price.per.'.length)
    : String(raw?.unitName ?? '').replace(/^PER_/, '').toLowerCase();
  if (!measure) return undefined;
  return { measure, price };
}

/** Map one decorated product (search) or `product` (detail) onto the shared shape. */
export function normaliseProduct(p: any): Product {
  const uid = p?.retailerProductId;
  const name = typeof p?.name === 'string' ? p.name.replace(/\s+/g, ' ').trim() : '';
  if (uid === undefined || uid === null || !/^\d+$/.test(String(uid)) || !name) {
    throw new Error('Morrisons returned a product without a retailer product id or name');
  }

  const currency = p?.price?.currency;
  const product: Product = {
    product_uid: String(uid),
    name,
    retail_price: { price: currency === undefined || currency === 'GBP' ? toPrice(p?.price?.amount) : null },
    in_stock: toStock(p?.available),
    provider: 'morrisons',
  };

  const unitPrice = parseUnitPrice(p?.unitPrice);
  if (unitPrice) product.unit_price = unitPrice;
  if (typeof p?.image?.src === 'string' && p.image.src.startsWith('https://')) product.image_url = p.image.src;
  if (typeof p?.packSizeDescription === 'string' && p.packSizeDescription.trim()) {
    product.size = p.packSizeDescription.trim();
  }

  const rating = toPrice(p?.ratingSummary?.overallRating);
  const count = Number(p?.ratingSummary?.count);
  if (rating !== null && rating <= 5 && Number.isInteger(count) && count > 0) {
    product.rating = rating;
    product.review_count = count;
  }

  const life = shelfLifeDays(p?.guaranteedProductLife);
  if (life !== undefined) product.shelf_life_days = life;
  return product;
}

/**
 * Search rows from one response. `[]` only for a well-formed empty result;
 * anything that isn't the expected shape throws.
 */
export function parseSearchResponse(data: any): SearchPage {
  if (!data || typeof data !== 'object' || !Array.isArray(data.productGroups)) {
    throw new Error('Morrisons returned an unexpected search response (no productGroups)');
  }
  const rows: any[] = [];
  for (const group of data.productGroups) {
    if (!group || typeof group !== 'object') {
      throw new Error('Morrisons returned an unexpected search response (malformed product group)');
    }
    rows.push(...(Array.isArray(group.decoratedProducts) ? group.decoratedProducts : []));
  }
  const token = data?.metadata?.nextPageToken;
  return { rows, nextPageToken: typeof token === 'string' && token ? token : undefined };
}

/** Normalise rows, dropping duplicates (a product can appear in several groups) and malformed rows. */
export function productsFromRows(rows: any[]): Product[] {
  const products: Product[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const row of rows) {
    let product: Product;
    try {
      product = normaliseProduct(row);
    } catch {
      malformed++;
      continue;
    }
    if (seen.has(product.product_uid)) continue;
    seen.add(product.product_uid);
    products.push(product);
  }
  if (rows.length > 0 && malformed === rows.length) {
    throw new Error('Morrisons returned search results, but none could be read');
  }
  return products;
}

function errorMessage(error: unknown, action: string): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const hint = status === 403 ? ' — possibly bot protection; try again later' : '';
    return new Error(`Morrisons ${action} failed${status ? ` (HTTP ${status})` : ''}${hint}`);
  }
  return error instanceof Error ? error : new Error(`Morrisons ${action} failed: ${String(error)}`);
}

export class MorrisonsProvider implements GroceryProvider {
  readonly name = 'morrisons';

  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: MORRISONS_BASE,
      timeout: 15_000,
      headers: { Accept: 'application/json; charset=utf-8' },
    });
  }

  private async fetchPage(query: string, pageSize: number, pageToken?: string): Promise<SearchPage> {
    let data: any;
    try {
      const response = await this.http.get(SEARCH_PATH, {
        params: {
          q: query,
          maxPageSize: pageSize,
          maxProductsToDecorate: pageSize,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      data = response.data;
    } catch (error) {
      throw errorMessage(error, 'search');
    }
    return parseSearchResponse(data);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalisedQuery = query.trim();
    if (!normalisedQuery) throw new Error('Morrisons search query must not be empty');
    if (options.category) throw new Error('Morrisons category filtering is not implemented yet');

    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('Morrisons search limit must be a non-negative integer');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('Morrisons search offset must be a non-negative integer');
    }
    if (limit === 0) return [];

    const wanted = offset + limit;
    const pageSize = Math.min(MORRISONS_MAX_PAGE_SIZE, wanted);
    const products: Product[] = [];
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    let token: string | undefined;

    for (let page = 0; page < MAX_PAGES && products.length < wanted; page++) {
      const { rows, nextPageToken } = await this.fetchPage(normalisedQuery, pageSize, token);
      const fresh = productsFromRows(rows).filter((p) => !seenIds.has(p.product_uid));
      if (fresh.length === 0) break; // empty or fully overlapping page: stop rather than loop
      for (const p of fresh) seenIds.add(p.product_uid);
      products.push(...fresh);
      if (!nextPageToken || seenTokens.has(nextPageToken)) break;
      seenTokens.add(nextPageToken);
      token = nextPageToken;
    }

    return products.slice(offset, wanted);
  }

  async getProduct(productId: string): Promise<Product> {
    const id = String(productId ?? '').trim();
    if (!/^\d+$/.test(id)) {
      throw new Error('Morrisons product ids are numeric retailer product ids, e.g. 113028499');
    }
    let data: any;
    try {
      const response = await this.http.get(PRODUCT_PATH, { params: { retailerProductId: id } });
      data = response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`Morrisons has no product with id ${id}`);
      }
      throw errorMessage(error, 'product lookup');
    }
    if (!data?.product) throw new Error('Morrisons returned an unexpected product response (no product)');
    return normaliseProduct(data.product);
  }
}
