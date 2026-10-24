import { z } from "zod";
import {
  type FavoriteList,
  type Nutrient,
  type Order,
  type PriceFields,
  type Product,
  priceFields,
  productImage,
  productPrices,
  productUrl,
} from "../ahapi/index.ts";

// Each view has a Zod schema, used as (part of) a tool's outputSchema; the types derive from it.

const num = z.number().optional();
const str = z.string().optional();

/** The price fields of every offer and product row (spec 2a, A2). Null where AH gives no deal or no unit price. */
export const priceFieldsShape = {
  pack_price: z.number().nullable().describe("Normal shelf price of one pack, in euros"),
  deal_min_quantity: z
    .number()
    .nullable()
    .describe("Packs needed to get the deal (1 for a plain discount); null without a deal, or when the mechanism is not understood"),
  deal_total: z.number().nullable().describe("What you pay for deal_min_quantity packs with the deal, in euros"),
  deal_price_per_pack: z.number().nullable().describe("deal_total / deal_min_quantity, in euros"),
  unit_price: z.number().nullable().describe("Normal price per unit_price_unit, where AH gives one"),
  unit_price_unit: z.enum(["kg", "l", "stuk"]).nullable().describe("The unit of unit_price"),
};

const PRICE_TEXT = "Normal price of one pack in euros, whatever the deal. ";
const BONUS_PRICE_TEXT =
  "Price of one pack with the bonus, only where AH sends one: a percentage or euro discount, or a price for one pack ('VOOR 1.99'). " +
  "Absent for deals on several packs ('2e gratis', '2 voor 5.00'): then deal_min_quantity packs cost deal_total, which is deal_price_per_pack a pack.";

/** Product row of ah_search_products and ah_get_bonus_group_products. */
const productRowShape = {
  id: z.number(),
  title: z.string(),
  url: z.string(),
  price: z.number().describe(PRICE_TEXT + "Same as pack_price."),
  bonus_price: num.describe(BONUS_PRICE_TEXT),
  unit: str,
  is_bonus: z.boolean(),
  bonus_mechanism: str,
  image_url: str.describe("Only with include_images: true"),
  ...priceFieldsShape,
};
export const productRow = z.object(productRowShape);

/** A group's products: the row, and the bonus category of the group (not the product's own mainCategory). */
export const groupProductRow = z.object({ ...productRowShape, category: z.string().describe("The bonus category of the group, as in ah_get_bonus_offers") });

/** Product in the alternatives of a product: the row before v1.2.0, which M8 does not change. */
export const productSummary = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  price: z.number(),
  bonus_price: num,
  unit: str,
  is_bonus: z.boolean(),
  bonus_mechanism: str,
  image_url: str,
});
type ProductSummary = z.infer<typeof productSummary>;

/** Product in ah_get_products. */
export const productDetail = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  brand: str,
  category: str,
  description: str.describe("Only with include_description: true"),
  price: z.number().describe(PRICE_TEXT + "Same as pack_price."),
  bonus_price: num.describe(BONUS_PRICE_TEXT),
  unit_size: str,
  unit_price_description: str,
  is_bonus: z.boolean(),
  bonus_mechanism: str,
  nutri_score: str,
  is_available: z.boolean(),
  property_icons: z.array(z.string()).optional(),
  nutritional_info: z.array(z.object({ type: z.string(), name: z.string(), value: z.string() })).optional(),
  image_url: str.describe("Only with include_images: true"),
  ingredients: str.describe("Only with include_ingredients: true, where AH has them"),
  allergens: z
    .array(z.object({ name: z.string(), level: z.enum(["contains", "may_contain"]) }))
    .optional()
    .describe("Only with include_ingredients: true, where AH has them: what the product contains or may contain"),
  ...priceFieldsShape,
});

export const orderView = z.object({
  id: z.number(),
  state: str,
  items: z.array(
    z.object({ product_id: z.number(), name: str, url: z.string(), quantity: z.number(), price: num }),
  ),
  total_price: num,
  total_discount: num,
});

export const favoriteListView = z.object({ id: z.string(), name: z.string(), item_count: z.number(), updated_at: str });

/** What the product row of a search, product or group says about prices. */
function rowPrices(p: Product): PriceFields {
  return priceFields({
    source: "search",
    mechanism: p.bonusMechanism,
    was: productPrices(p).regular,
    now: p.currentPrice,
    unitPriceDescription: p.unitPriceDescription,
    bundle: p.isVirtualBundle,
  });
}

export function summarizeProduct(p: Product): ProductSummary {
  const { regular, bonus } = productPrices(p);
  return {
    id: p.webshopId,
    title: p.title,
    url: productUrl(p.webshopId, p.title),
    price: regular,
    bonus_price: bonus || undefined,
    unit: p.salesUnitSize || undefined,
    is_bonus: Boolean(p.isBonus),
    bonus_mechanism: p.bonusMechanism || undefined,
    image_url: productImage(p) || undefined,
  };
}

/** A row of ah_search_products or ah_get_bonus_group_products (which adds the group's category). */
export function productRowView(p: Product, opts: { images?: boolean; category?: string } = {}): z.infer<typeof productRow> & { category?: string } {
  const { regular, bonus } = productPrices(p);
  return {
    id: p.webshopId,
    title: p.title,
    url: productUrl(p.webshopId, p.title),
    price: regular,
    bonus_price: bonus || undefined,
    unit: p.salesUnitSize || undefined,
    is_bonus: Boolean(p.isBonus),
    bonus_mechanism: p.bonusMechanism || undefined,
    ...(opts.images ? { image_url: productImage(p) || undefined } : {}),
    ...(opts.category === undefined ? {} : { category: opts.category }),
    ...rowPrices(p),
  };
}

export interface DetailOptions {
  images?: boolean;
  description?: boolean;
  ingredients?: boolean;
}

export function detailProduct(p: Product, nutrition: Nutrient[] | undefined, opts: DetailOptions = {}): z.infer<typeof productDetail> {
  const { regular, bonus } = productPrices(p);
  return {
    id: p.webshopId,
    title: p.title,
    url: productUrl(p.webshopId, p.title),
    brand: p.brand || undefined,
    category: p.mainCategory || undefined,
    ...(opts.description ? { description: p.descriptionHighlights || undefined } : {}),
    price: regular,
    bonus_price: bonus || undefined,
    unit_size: p.salesUnitSize || undefined,
    unit_price_description: p.unitPriceDescription || undefined,
    is_bonus: Boolean(p.isBonus),
    bonus_mechanism: p.bonusMechanism || undefined,
    nutri_score: p.nutriscore || undefined,
    is_available: Boolean(p.isOrderable),
    property_icons: p.propertyIcons?.length ? p.propertyIcons : undefined,
    nutritional_info: nutrition?.length ? nutrition : undefined,
    ...(opts.images ? { image_url: productImage(p) || undefined } : {}),
    ...(opts.ingredients ? { ingredients: p.ingredients, allergens: p.allergens } : {}),
    ...rowPrices(p),
  };
}

export function viewOrder(o: Order): z.infer<typeof orderView> {
  return {
    id: o.id,
    state: o.state || undefined,
    items: o.items.map((it) => ({
      product_id: it.productId,
      name: it.title || undefined,
      url: productUrl(it.productId, it.title),
      quantity: it.quantity,
      price: it.price || undefined,
    })),
    total_price: o.totalPrice || undefined,
    total_discount: o.totalDiscount || undefined,
  };
}

export function viewFavoriteList(l: FavoriteList): z.infer<typeof favoriteListView> {
  return { id: l.id, name: l.name, item_count: l.itemCount, updated_at: l.updatedAt };
}
