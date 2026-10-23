import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AhClient,
  bonusGroupUrl,
  type BonusOffer,
  type BonusPeriod,
  getBonusGroupProducts,
  getBonusPeriods,
  getBonusSection,
  getPreviouslyBoughtBonus,
  productUrl,
} from "../ahapi/index.ts";
import { log } from "../log.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry, wrapError } from "./common.ts";
import { productSummary, summarizeProduct } from "./views.ts";

const period = z.enum(["current", "next"]).optional();

const offerView = z.object({
  id: z.number().optional(),
  bonus_segment_id: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  original_price: z.number().optional(),
  bonus_price: z.number().optional(),
  discount_percentage: z.number().optional(),
  bonus_mechanism: z.string().optional(),
});

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
        "Supports optional keyword filter to find e.g. cheese on bonus: set query='kaas'. " +
        "Set previously_bought=true for offers on products the user bought before (AH's 'Eerder gekocht'). " +
        "Group deals (e.g. '2+1 gratis', 'Alle yoghurt 25% korting') have no id but a bonus_segment_id — " +
        "pass that to ah_get_bonus_group_products to see the individual products in the group. " +
        "Returns id, bonus_segment_id, title, original_price, bonus_price, discount_percentage, bonus_mechanism.",
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
      },
      output: { offers: z.array(offerView) },
    },
    async (c, args) => {
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ offers: [] }, p);
      const limit = orDefault(args.limit, 20);
      const query = (args.query ?? "").toLowerCase();

      const offers: z.infer<typeof offerView>[] = [];
      const add = (o: { id?: number; segment?: string; title: string; was?: number; now?: number; mechanism?: string | null }) => {
        if (offers.length >= limit || (query && !o.title.toLowerCase().includes(query))) return;
        const discount = o.was && o.now ? Math.round((1 - o.now / o.was) * 100) : undefined;
        offers.push({
          id: o.id || undefined,
          bonus_segment_id: o.segment || undefined,
          title: o.title,
          url: o.id ? productUrl(o.id, o.title) : o.segment ? bonusGroupUrl(o.segment) : undefined,
          original_price: o.was || undefined,
          // Absent for deals like "2 voor 1.19"; bonus_mechanism describes those.
          bonus_price: o.now || undefined,
          discount_percentage: discount || undefined,
          bonus_mechanism: o.mechanism || undefined,
        });
      };
      const all = args.previously_bought ? await getPreviouslyBoughtBonus(c, p.start) : await bonusOffers(ctx, c, p);
      for (const bo of all) {
        const products = bo.product ? [bo.product] : (bo.group?.products ?? []);
        for (const pr of products) {
          add({ id: pr.webshopId, title: pr.title, was: pr.priceBeforeBonus, now: pr.currentPrice, mechanism: pr.bonusMechanism });
        }
        if (bo.group && !bo.group.products?.length) {
          const g = bo.group;
          add({ segment: g.id, title: g.segmentDescription, was: g.exampleFromPrice, now: g.exampleForPrice, mechanism: g.discountDescription });
        }
      }
      return structured({ offers });
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
        "Get all individual products belonging to a specific Albert Heijn bonus promotion group. " +
        "Use this to drill into a deal like '2+1 gratis kaas' or 'Alle yoghurt 25% korting'. " +
        "Get segment_id from the bonus_segment_id field in ah_get_bonus_offers results. " +
        "For an offer from next week's bonus, set period='next'. " +
        "Returns the same fields as ah_search_products.",
      input: {
        segment_id: z.string().describe("Bonus segment ID from the bonus_segment_id field in ah_get_bonus_offers"),
        period: period.describe("Bonus week of the offer: 'current' (default) or 'next'"),
      },
      output: { products: z.array(productSummary) },
    },
    async (c, args) => {
      if (!args.segment_id) throw new Error("segment_id is required");
      const p = await bonusPeriod(ctx, c, args.period);
      if (typeof p === "string") return structured({ products: [] }, p);
      return structured({ products: (await getBonusGroupProducts(c, args.segment_id, p)).map(summarizeProduct) });
    },
  );
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
