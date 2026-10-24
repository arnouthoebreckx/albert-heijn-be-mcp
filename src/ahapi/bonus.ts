import { site } from "../site.ts";
import type { AhClient } from "./client.ts";
import { fromGraphqlProduct, GRAPHQL_PRODUCT_FIELDS, type GraphqlProduct, type Product } from "./products.ts";

/** Weekly bonus period. Index 0 is this week; next week appears a few days before it starts. */
export interface BonusPeriod {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  /** When the following week's bonus becomes visible (YYYY-MM-DD). */
  nextVisibleFrom?: string;
  /** National categories, for getBonusSection. */
  categories: string[];
}

/** Published bonus periods, current week first. */
export async function getBonusPeriods(c: AhClient): Promise<BonusPeriod[]> {
  const res = await c.request<{
    periods?: {
      bonusStartDate: string;
      bonusEndDate: string;
      nextPeriodVisibleFrom?: string;
      tabs?: { urlMetadataList?: { bonusType: string; description: string }[] }[];
    }[];
  }>("/mobile-services/bonuspage/v3/metadata");
  return (res.periods ?? []).map((p) => {
    const categories = new Set<string>();
    for (const tab of p.tabs ?? []) {
      for (const m of tab.urlMetadataList ?? []) {
        if (m.bonusType === "NATIONAL" && m.description) categories.add(m.description);
      }
    }
    return {
      start: p.bonusStartDate,
      end: p.bonusEndDate,
      nextVisibleFrom: p.nextPeriodVisibleFrom,
      categories: [...categories],
    };
  });
}

/**
 * ah.be's bonus categories that are not food (spec 2a, A3): what food_only drops. A category that can be
 * either stays out of this list, so food_only keeps a household item rather than drop a food offer: baby
 * food and nappies share "Baby en kind", vitamins and rice bars share "Gezondheid en sport".
 */
export const NON_FOOD_CATEGORIES: readonly string[] = ["Huishouden", "Drogisterij", "Koken, tafelen, vrije tijd"];

/** The page of a group deal on the site, listing its products. */
export function bonusGroupUrl(segmentId: string): string {
  return `${site().web}/bonus/groep/${segmentId}`;
}

/** Group deal, e.g. "2+1 gratis". */
export interface BonusGroup {
  /** For getBonusGroupProducts. */
  id: string;
  segmentDescription: string;
  discountDescription?: string;
  category?: string;
  exampleFromPrice?: number;
  exampleForPrice?: number;
  bonusStartDate?: string;
  bonusEndDate?: string;
  products?: Product[];
}

/** Bonus page entry: a product or a group deal. */
export interface BonusOffer {
  product?: Product;
  group?: BonusGroup;
  /** The bonus category of the section the offer came from; none for the previously bought offers. */
  category?: string;
}

async function fetchSection(c: AhClient, path: string, params: Record<string, string>, category?: string): Promise<BonusOffer[]> {
  const query = new URLSearchParams({ application: site().application, ...params });
  const res = await c.request<{ bonusGroupOrProducts?: { product?: Product; bonusGroup?: BonusGroup }[] }>(
    `/mobile-services/bonuspage/v2/${path}?${query}`,
  );
  return (res.bonusGroupOrProducts ?? []).map((it) => ({ product: it.product, group: it.bonusGroup, category }));
}

/** National offers of a category; date picks the bonus period. */
export function getBonusSection(c: AhClient, category: string, date: string): Promise<BonusOffer[]> {
  return fetchSection(c, "section", { date, promotionType: "NATIONAL", category }, category);
}

/** Offers on products the member bought before (AH's "Eerder gekocht"); date picks the bonus period. */
export function getPreviouslyBoughtBonus(c: AhClient, date: string): Promise<BonusOffer[]> {
  return fetchSection(c, "section/previously-bought", { date });
}

/** A product of the bonus search, which says which group deal it belongs to (null if none). */
export type BonusProduct = Product;

/** AH lists about 1,800 bonus products, 18 pages of 100; more than this many pages is not a list worth reading whole. */
const MAX_BONUS_PAGES = 40;

/** Every product on bonus now, from the bonus-filtered search, 100 a request. The search has no way to ask for another week. */
export async function getBonusProducts(c: AhClient): Promise<BonusProduct[]> {
  const page = (n: number) => {
    const query = new URLSearchParams({ query: "", page: String(n), size: "100", sortOn: "RELEVANCE", filters: "bonus=Bonus" });
    return c.request<{ page?: { totalPages?: number }; products?: BonusProduct[] }>(`/mobile-services/product/search/v2?${query}`);
  };
  const first = await page(0);
  const pages = first.page?.totalPages ?? 1;
  if (pages > MAX_BONUS_PAGES) throw new Error(`AH lists ${pages} pages of bonus products, more than the ${MAX_BONUS_PAGES} this server reads`);
  const products = first.products ?? [];
  for (let n = 1; n < pages; n++) products.push(...((await page(n)).products ?? []));
  return products;
}

/**
 * Products of a group deal. On ah.be AH's group query returns nothing, so the group is the products of the
 * bonus search whose bonusSegmentId is its id; bonusProducts lets the caller cache that list.
 */
export async function getBonusGroupProducts(
  c: AhClient,
  groupId: string,
  period: BonusPeriod,
  bonusProducts: () => Promise<BonusProduct[]> = () => getBonusProducts(c),
): Promise<BonusProduct[]> {
  if (site().name === "be") {
    return (await bonusProducts()).filter((p) => String(p.bonusSegmentId) === groupId).map((p) => ({ ...p, isBonus: true }));
  }
  const query = `query BonusGroupProducts($id: String, $start: String, $end: String) {
  bonusPromotions(input: {id: $id, periodStart: $start, periodEnd: $end}) {
    products { ${GRAPHQL_PRODUCT_FIELDS} }
  }
}`;
  const data = await c.graphql<{ bonusPromotions: { products: GraphqlProduct[] }[] }>(query, {
    id: groupId,
    start: period.start,
    end: period.end,
  });
  // Every product in a bonus group is on bonus, even when the price doesn't show it (e.g. "2+1 gratis").
  return data.bonusPromotions.flatMap((promo) => promo.products.map((p) => ({ ...fromGraphqlProduct(p), isBonus: true })));
}
