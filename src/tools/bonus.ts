import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  bonusGroupUrl,
  type BonusOffer,
  type BonusPeriod,
  getBonusGroupProducts,
  getBonusPeriods,
  getBonusProducts,
  getBonusSection,
  getPreviouslyBoughtBonus,
  NON_FOOD_CATEGORIES,
  type PriceSource,
  priceFields,
  productUrl,
} from "../ahapi/index.ts";
import { isAnonymous } from "../auth/anonymous.ts";
import { log } from "../log.ts";
import { site } from "../site.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry, wrapError } from "./common.ts";
import { groupProductRow, priceFieldsShape, productRowView } from "./views.ts";

/** previously_bought is AH's "Eerder gekocht": it belongs to an account. */
const PREVIOUSLY_BOUGHT_NEEDS_LOGIN = "previously_bought needs a logged-in Albert Heijn account; this server runs without one";

const NEXT_GROUPS_UNAVAILABLE =
  "The products of a group in next week's bonus are not available on ah.be: AH lists only this week's bonus products there. " +
  "Ask again with period='current' once the bonus week has started.";

const period = z.enum(["current", "next"]).optional();

const DEFAULT_GROUP_LIMIT = 25;
const MAX_GROUP_LIMIT = 100;

const periodName = z.enum(["current", "next"]).describe("The bonus week this answer is for");
const validFrom = z.string().optional().describe("First day of the bonus week (YYYY-MM-DD, inclusive); absent when next week is not published yet");
const validUntil = z.string().optional().describe("Last day of the bonus week (YYYY-MM-DD, inclusive); absent when next week is not published yet");

const offerView = z.object({
  id: z.number().optional(),
  bonus_segment_id: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  category: z.string().optional().describe("The ah.be bonus category of the offer, as in the categories of the answer"),
  original_price: z
    .number()
    .optional()
    .describe(
      "Regular price as AH sends it, for the packs the deal needs (deal_min_quantity packs, e.g. two bags for '2e gratis'), not for one pack: pack_price is one pack. " +
        "A group offer has no product of its own: this is AH's example product of the group.",
    ),
  bonus_price: z
    .number()
    .optional()
    .describe(
      "Price of those packs with the deal, as AH sends it (deal_total for deal_min_quantity packs). Absent for deals like '2 voor 1.19'. " +
        "A group offer has no product of its own: this is AH's example product of the group.",
    ),
  discount_percentage: z.number().optional(),
  bonus_mechanism: z.string().optional(),
  valid_from: z.string().optional().describe("Only when this offer starts on another day than the week (YYYY-MM-DD)"),
  valid_until: z.string().optional().describe("Only when this offer ends on another day than the week (YYYY-MM-DD)"),
  ...priceFieldsShape,
});

const categorySummary = z.object({ name: z.string(), offer_count: z.number().describe("Offers in this category over the whole week, before any filter") });

const lower = (s: string) => s.toLowerCase();

export function registerBonusTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_bonus_offers",
      title: "Albert Heijn: Bonus Offers",
      kind: "readOnly",
      description:
        "Get Albert Heijn bonus/promotional offers. " +
        "Use this (not ah_search_products) when the user asks what is on bonus/sale/discount. " +
        "Returns this week's bonus by default; set period='next' for next week's bonus, " +
        "which AH publishes a few days before the new bonus week starts. " +
        "Every answer says which week it covers (period, valid_from, valid_until). " +
        "Supports optional keyword filter to find e.g. cheese on bonus: set query='kaas'. " +
        "Every offer has a category (AH's bonus category): the answer's categories lists every category of the week with its " +
        "number of offers (offer_count, before any filter), so set categories to a list of those names to get only those, " +
        "and food_only=true to leave out the non-food categories (household, drugstore, cooking and table items). " +
        "Set previously_bought=true for offers on products the user bought before (AH's 'Eerder gekocht'). " +
        "Group deals (e.g. '2+1 gratis', 'Alle yoghurt 25% korting') have no id but a bonus_segment_id — " +
        "pass that to ah_get_bonus_group_products to see the individual products in the group. " +
        "Returns id, bonus_segment_id, title, category, original_price, bonus_price, discount_percentage, bonus_mechanism, " +
        "and the price fields pack_price, deal_min_quantity, deal_total, deal_price_per_pack, unit_price, unit_price_unit " +
        "(use these for a shopping line: original_price and bonus_price can be for two packs).",
      input: {
        limit: z.number().int().optional().describe("Maximum number of results to return (default 20)"),
        query: z
          .string()
          .optional()
          .describe("Optional keyword filter (Dutch or English) applied client-side, e.g. 'kaas', 'vlees', 'bier'"),
        period: period.describe("Which bonus week to return: 'current' (default) or 'next'"),
        previously_bought: z
          .boolean()
          .optional()
          .describe("Only offers on products the user bought before"),
        categories: z
          .array(z.string())
          .optional()
          .describe("Only offers in these bonus categories, by name as in the categories of the answer (case does not matter; an unknown name is an error)"),
        food_only: z
          .boolean()
          .optional()
          .describe("Leave out the non-food categories (default false). With categories, only the food ones of them come back"),
      },
      output: {
        period: periodName,
        valid_from: validFrom,
        valid_until: validUntil,
        categories: z.array(categorySummary).describe("Every bonus category of the week with its number of offers, before any filter"),
        offers: z.array(offerView),
      },
    },
    async (c, args) => {
      const name = args.period === "next" ? "next" : "current";
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ period: name, categories: [], offers: [] }, p);
      const limit = orDefault(args.limit, 20);
      const query = (args.query ?? "").toLowerCase();

      const all = args.previously_bought ? await getPreviouslyBoughtBonus(c, p.start) : await bonusOffers(ctx, c, p);
      const categories = categoryCounts(p, all);
      const wanted = args.categories && new Set(args.categories.map(lower));
      if (wanted) {
        const unknown = args.categories!.filter((n) => !categories.some((c) => lower(c.name) === lower(n)));
        if (unknown.length) {
          throw new Error(
            `Unknown bonus category ${unknown.map((n) => `"${n}"`).join(", ")}. ` +
              `The categories of the ${name} bonus week are: ${categories.map((c) => c.name).join("; ")}.`,
          );
        }
      }
      const nonFood = args.food_only ? new Set(NON_FOOD_CATEGORIES.map(lower)) : undefined;

      const offers: z.infer<typeof offerView>[] = [];
      const add = (
        o: { id?: number; segment?: string; title: string; was?: number; now?: number; mechanism?: string | null; category?: string; source: PriceSource; unit?: string | null; start?: string | null; end?: string | null },
      ) => {
        if (offers.length >= limit || (query && !o.title.toLowerCase().includes(query))) return;
        if ((wanted && !wanted.has(lower(o.category ?? ""))) || nonFood?.has(lower(o.category ?? ""))) return;
        const discount = o.was && o.now ? Math.round((1 - o.now / o.was) * 100) : undefined;
        const own = (o.start && o.start !== p.start) || (o.end && o.end !== p.end);
        offers.push({
          id: o.id || undefined,
          bonus_segment_id: o.segment || undefined,
          title: o.title,
          url: o.id ? productUrl(o.id, o.title) : o.segment ? bonusGroupUrl(o.segment) : undefined,
          category: o.category || undefined,
          original_price: o.was || undefined,
          // Absent for deals like "2 voor 1.19"; bonus_mechanism describes those.
          bonus_price: o.now || undefined,
          discount_percentage: discount || undefined,
          bonus_mechanism: o.mechanism || undefined,
          valid_from: own ? (o.start ?? p.start) : undefined,
          valid_until: own ? (o.end ?? p.end) : undefined,
          ...priceFields({ source: o.source, mechanism: o.mechanism, was: o.was, now: o.now, unitPriceDescription: o.unit }),
        });
      };
      for (const bo of all) {
        const products = bo.product ? [bo.product] : (bo.group?.products ?? []);
        for (const pr of products) {
          add({
            id: pr.webshopId,
            title: pr.title,
            was: pr.priceBeforeBonus,
            now: pr.currentPrice,
            mechanism: pr.bonusMechanism,
            category: offerCategory(bo),
            source: "section",
            unit: pr.unitPriceDescription,
            start: pr.bonusStartDate,
            end: pr.bonusEndDate,
          });
        }
        if (bo.group && !bo.group.products?.length) {
          const g = bo.group;
          add({
            segment: g.id,
            title: g.segmentDescription,
            was: g.exampleFromPrice,
            now: g.exampleForPrice,
            mechanism: g.discountDescription,
            category: offerCategory(bo),
            source: "example",
            start: g.bonusStartDate,
            end: g.bonusEndDate,
          });
        }
      }
      return structured({ period: name, valid_from: p.start, valid_until: p.end, categories, offers });
    },
    (args) => {
      if (args.previously_bought && isAnonymous(ctx.clients)) throw new Error(PREVIOUSLY_BOUGHT_NEEDS_LOGIN);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_bonus_group_products",
      title: "Albert Heijn: Bonus Group Products",
      kind: "readOnly",
      description:
        "Get the individual products belonging to a specific Albert Heijn bonus promotion group. " +
        "Use this to drill into a deal like '2+1 gratis kaas' or 'Alle yoghurt 25% korting'. " +
        "Get segment_id from the bonus_segment_id field in ah_get_bonus_offers results. " +
        "Pages of limit products (default 25, at most 100) from offset; total is the size of the whole group. " +
        "Every product has the group's category. " +
        "An id that is not in that week's bonus, and period='next' on ah.be, are errors; an empty products list means the group has no products today. " +
        "Returns the same fields as ah_search_products (image_url only with include_images=true), plus category.",
      input: {
        segment_id: z.string().describe("Bonus segment ID from the bonus_segment_id field in ah_get_bonus_offers"),
        period: period.describe("Bonus week of the offer: 'current' (default); 'next' is an error on ah.be"),
        limit: z.number().int().optional().describe(`Maximum number of products to return (default ${DEFAULT_GROUP_LIMIT}, max ${MAX_GROUP_LIMIT})`),
        offset: z.number().int().optional().describe("Number of products to skip, for the next page (default 0)"),
        include_images: z.boolean().optional().describe("Include image_url in each product (default false)"),
      },
      output: {
        period: periodName,
        valid_from: validFrom,
        valid_until: validUntil,
        total: z.number().describe("Products in the group before paging"),
        products: z.array(groupProductRow),
      },
    },
    async (c, args) => {
      if (!args.segment_id) throw new Error("segment_id is required");
      // The bonus search of ah.be lists this week only, so next week's groups can't be built there.
      if (args.period === "next" && site().name === "be") throw new Error(NEXT_GROUPS_UNAVAILABLE);
      const name = args.period === "next" ? "next" : "current";
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ period: name, total: 0, products: [] }, p);
      const category = groupCategory(await bonusOffers(ctx, c, p), args.segment_id);
      if (category === undefined) {
        log.warn("no such bonus group", { segment_id: args.segment_id, period: name });
        throw new Error(`no bonus group ${args.segment_id} in the ${name} bonus week. Get segment_id from bonus_segment_id in ah_get_bonus_offers for the same period.`);
      }
      const bonusProducts = () => ctx.searches.getOrLoad(`bonus:${p.start}`, () => getBonusProducts(c));
      // By id, so that a page is the same page whatever order AH answers in.
      const group = (await getBonusGroupProducts(c, args.segment_id, p, bonusProducts)).sort((a, b) => a.webshopId - b.webshopId);
      const limit = Math.min(orDefault(args.limit, DEFAULT_GROUP_LIMIT), MAX_GROUP_LIMIT);
      const offset = Math.max(args.offset ?? 0, 0);
      const products = group.slice(offset, offset + limit).map((pr) => productRowView(pr, { images: args.include_images, category }));
      return structured({ period: name, valid_from: p.start, valid_until: p.end, total: group.length, products });
    },
  );
}

/** The bonus category of an offer: its group's own, else the section it came from, else its product's. */
function offerCategory(o: BonusOffer): string | undefined {
  return o.group?.category || o.category || o.product?.mainCategory || undefined;
}

/** Every category of the week, as ah.be lists them, with the number of offers in it; those seen only in the offers come last. */
function categoryCounts(p: BonusPeriod, offers: BonusOffer[]): { name: string; offer_count: number }[] {
  const counts = new Map<string, number>(p.categories.map((name) => [name, 0]));
  for (const o of offers) {
    const name = offerCategory(o);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, offer_count]) => ({ name, offer_count }));
}

/** The category of the group with this id in the week's offers (a product offer's segment counts too), or undefined if there is none. */
function groupCategory(offers: BonusOffer[], segmentId: string): string | undefined {
  for (const o of offers) {
    const inGroup = o.group?.id === segmentId || String(o.product?.bonusSegmentId) === segmentId;
    if (inGroup) return offerCategory(o) ?? "";
  }
  return undefined;
}

/** The requested period, or a message if next week's bonus is not published yet. */
async function bonusPeriod(
  ctx: ToolContext,
  c: AhClient,
  name: "current" | "next" | undefined,
): Promise<BonusPeriod | string> {
  const periods = await ctx.bonusPeriods.getOrLoad("", () => getBonusPeriods(c));
  const current = periods[0];
  if (!current?.start) throw new Error("AH returned no current bonus period");
  if (name !== "next") return current;
  if (periods[1]?.start) return periods[1];
  const when = current.nextVisibleFrom
    ? `It becomes visible on ${current.nextVisibleFrom}.`
    : "It usually appears a few days before the new bonus week starts.";
  return `Next week's bonus has not been published by Albert Heijn yet. ${when} This week's bonus runs until ${current.end}.`;
}

/** All national offers of a period, cached. Failed categories are skipped; partial results aren't cached. */
async function bonusOffers(ctx: ToolContext, c: AhClient, p: BonusPeriod): Promise<BonusOffer[]> {
  const cached = ctx.bonuses.get(p.start);
  if (cached) return cached;

  const sections: (BonusOffer[] | undefined)[] = new Array(p.categories.length);
  const errors: unknown[] = [];
  await parallel(p.categories.length, 4, async (i) => {
    const category = p.categories[i]!;
    sections[i] = await nonFatal(
      () => withRetry("ah_get_bonus_offers", () => getBonusSection(c, category, p.start)),
      (err) => {
        errors.push(err);
        log.warn("skipping bonus category", { category, err });
        return undefined;
      },
    );
  });
  if (p.categories.length > 0 && errors.length === p.categories.length) {
    throw wrapError("failed to get bonus offers", errors[0]);
  }

  const seen = new Set<string>();
  const offers: BonusOffer[] = [];
  for (const o of sections.flat()) {
    if (!o) continue;
    const key = o.product ? `p${o.product.webshopId}` : o.group ? `g${o.group.id}` : "";
    if (key && !seen.has(key)) {
      seen.add(key);
      offers.push(o);
    }
  }
  if (errors.length === 0) ctx.bonuses.set(p.start, offers);
  return offers;
}
