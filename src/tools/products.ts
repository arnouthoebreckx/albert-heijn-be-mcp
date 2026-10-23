import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  getNutrition,
  getProduct,
  getProductAlternatives,
  type Product,
  type SearchOptions,
  type SearchSort,
  searchProducts,
} from "../ahapi/index.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry } from "./common.ts";
import { detailProduct, productDetail, productSummary, summarizeProduct } from "./views.ts";

const MAX_QUERIES = 10;
const MAX_PRODUCT_IDS = 20;

/** Search filters → AH property ids. */
const FILTERS = {
  organic: "np_biologisch",
  prijsfavoriet: "np_verbluffen",
  new: "np_nieuw",
  frozen: "diepvries",
  vegan: "sp_include_dieet_veganistisch",
  vegetarian: "sp_include_dieet_vegetarisch",
  low_sugar: "sp_include_dieet_laag_suiker",
  low_fat: "sp_include_dieet_laag_vet",
  low_salt: "sp_include_dieet_laag_zout",
  gluten_free: "sp_include_intolerance_geen_gluten",
  lactose_free: "sp_include_intolerance_geen_lactose",
  milk_free: "sp_include_intolerance_geen_melk",
  egg_free: "sp_include_intolerance_geen_eieren",
  nut_free: "sp_include_intolerance_geen_noten",
  peanut_free: "sp_include_intolerance_geen_pindas",
  soy_free: "sp_include_intolerance_geen_soja",
  fish_free: "sp_include_intolerance_geen_vis",
  shellfish_free: "sp_include_intolerance_geen_schelpdieren",
  sesame_free: "sp_include_intolerance_geen_sesam",
  celery_free: "sp_include_intolerance_geen_selderij",
  mustard_free: "sp_include_intolerance_geen_mosterd",
  lupin_free: "sp_include_intolerance_geen_lupine",
  sulphite_free: "sp_include_intolerance_geen_sulfiet",
} as const;
type Filter = keyof typeof FILTERS;

const SORTS = {
  relevance: "RELEVANCE",
  price_low_high: "PRICELOWHIGH",
  price_high_low: "PRICEHIGHLOW",
  most_bought: "PURCHASE_FREQUENCY",
  nutriscore: "NUTRISCORE",
} as const satisfies Record<string, SearchSort>;
type Sort = keyof typeof SORTS;

export function registerProductTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_search_products",
      title: "Albert Heijn: Search Products",
      kind: "readOnly",
      description:
        "Search Albert Heijn (Dutch supermarket) products by keyword. " +
        "Pass one or more queries (max 10) to search for several products in one call. " +
        "Prefer Dutch search terms for best results: " +
        "e.g. 'melk' (milk), 'kaas' (cheese), 'brood' (bread), 'kip' (chicken), 'appel' (apple). " +
        "Set bonus=true to return only products currently on promotion. " +
        "filters narrows results to products matching all of them, e.g. ['organic', 'gluten_free']: " +
        "organic, prijsfavoriet (AH's budget label), new, frozen, a diet (vegan, vegetarian, low_sugar, low_fat, low_salt), " +
        "or free from an allergen (gluten_free, lactose_free, milk_free, egg_free, nut_free, peanut_free, soy_free, " +
        "fish_free, shellfish_free, sesame_free, celery_free, mustard_free, lupin_free, sulphite_free). " +
        "sort orders results: relevance (default), price_low_high, price_high_low, most_bought (by this user), nutriscore. " +
        "Returns, per query: id, title, price, bonus_price, unit, is_bonus, bonus_mechanism, image_url.",
      input: {
        queries: z
          .array(z.string())
          .describe('Search queries in Dutch or English, e.g. ["melk"] or ["melk", "kaas", "brood"] (max 10)'),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Maximum results per query (default 10 for one query, 5 for several; max 30)"),
        bonus: z.boolean().optional().describe("Return only products currently on bonus/promotion"),
        filters: z
          .array(z.enum(Object.keys(FILTERS) as [Filter, ...Filter[]]))
          .optional()
          .describe('Only products matching all of these, e.g. ["organic", "vegan"]'),
        sort: z
          .enum(Object.keys(SORTS) as [Sort, ...Sort[]])
          .optional()
          .describe("Result order (default relevance)"),
      },
      output: {
        searches: z.array(z.object({ query: z.string(), results: z.array(productSummary), error: z.string().optional() })),
      },
    },
    async (c, { queries, limit, bonus, filters, sort }) => {
      const qs = queries.filter(Boolean).slice(0, MAX_QUERIES);
      if (qs.length === 0) throw new Error("provide at least one search query");
      const perQuery = Math.min(orDefault(limit, qs.length > 1 ? 5 : 10), 30);

      const results = qs.map((query) => ({
        query,
        results: [] as ReturnType<typeof summarizeProduct>[],
        error: undefined as string | undefined,
      }));
      const opts: SearchOptions = {
        bonus: Boolean(bonus),
        properties: [...new Set(filters ?? [])].map((f) => FILTERS[f]).sort(),
        sort: SORTS[sort ?? "relevance"],
      };
      await parallel(qs.length, 3, async (i) => {
        const r = results[i]!;
        await nonFatal(
          async () => {
            r.results = (await search(ctx, c, r.query, perQuery, opts)).map(summarizeProduct);
          },
          (err) => {
            r.error = (err as Error).message;
          },
        );
      });
      return structured({ searches: results });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_products",
      title: "Albert Heijn: Product Details",
      kind: "readOnly",
      description:
        "Get detailed information about one or more Albert Heijn products by ID (max 20). " +
        "Returns title, brand, category, description, price, unit size, bonus info, NutriScore, property icons. " +
        "Set include_nutritional_info=true to also return calories, fat, protein, etc. " +
        "Get product IDs from ah_search_products.",
      input: {
        product_ids: z
          .array(z.number().int())
          .describe("Product IDs from ah_search_products, e.g. [123456] or [123456, 789012] (max 20)"),
        include_nutritional_info: z.boolean().optional().describe("Include nutritional values (default false)"),
      },
      output: {
        products: z.array(z.union([productDetail, z.object({ id: z.number(), error: z.string() })])),
      },
    },
    async (c, { product_ids, include_nutritional_info }) => {
      const ids = product_ids.filter((id) => id > 0).slice(0, MAX_PRODUCT_IDS);
      if (ids.length === 0) throw new Error("provide at least one product ID");

      const results: (z.infer<typeof productDetail> | { id: number; error: string })[] = new Array(ids.length);
      await parallel(ids.length, 5, async (i) => {
        const id = ids[i]!;
        const key = String(id);
        results[i] = await nonFatal<z.infer<typeof productDetail> | { id: number; error: string }>(
          async () => {
            const p = await ctx.products.getOrLoad(key, () => withRetry("ah_get_products", () => getProduct(c, id)));
            const nutrition = include_nutritional_info
              ? await ctx.nutrition.getOrLoad(key, () => withRetry("ah_get_products", () => getNutrition(c, id)))
              : undefined;
            return detailProduct(p, nutrition);
          },
          (err) => ({ id, error: (err as Error).message }),
        );
      });
      return structured({ products: results });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_product_alternatives",
      title: "Albert Heijn: Product Alternatives",
      kind: "readOnly",
      description:
        "Get products Albert Heijn suggests instead of a given product: similar products and substitutes, " +
        "e.g. when it is sold out or to find a cheaper or organic option. " +
        "Returns the same fields as ah_search_products.",
      input: {
        product_id: z.number().int().describe("Product ID, e.g. from ah_search_products or ah_get_shopping_list"),
        limit: z.number().int().optional().describe("Maximum number of alternatives (default 10, max 30)"),
      },
      output: { products: z.array(productSummary) },
    },
    async (c, args) => {
      if (args.product_id <= 0) throw new Error("product_id is required");
      const size = Math.min(orDefault(args.limit, 10), 30);
      const alternatives = await ctx.searches.getOrLoad(`alternatives:${args.product_id}:${size}`, () =>
        withRetry("ah_get_product_alternatives", () => getProductAlternatives(c, args.product_id, size)),
      );
      const message = alternatives.length ? undefined : `AH suggests no alternatives for product ${args.product_id}.`;
      return structured({ products: alternatives.map(summarizeProduct) }, message);
    },
  );
}

/** Cached, retried product search. */
export function search(ctx: ToolContext, c: AhClient, query: string, limit: number, opts: SearchOptions): Promise<Product[]> {
  // most_bought orders by this account's purchases, so it is cached per login.
  const account = opts.sort === "PURCHASE_FREQUENCY" ? c.token : undefined;
  return ctx.searches.getOrLoad(JSON.stringify([query, limit, opts, account]), () =>
    withRetry("ah_search_products", () => searchProducts(c, query, limit, opts)),
  );
}
