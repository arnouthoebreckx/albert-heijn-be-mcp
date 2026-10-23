import { z } from "zod";
import { type FavoriteList, type Nutrient, type Order, type Product, productImage, productPrices, productUrl } from "../ahapi/index.ts";

// Each view has a Zod schema, used as (part of) a tool's outputSchema; the types derive from it.

const num = z.number().optional();
const str = z.string().optional();

/** Product in search and list results. */
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
  description: str,
  price: z.number(),
  bonus_price: num,
  unit_size: str,
  unit_price_description: str,
  is_bonus: z.boolean(),
  bonus_mechanism: str,
  nutri_score: str,
  is_available: z.boolean(),
  property_icons: z.array(z.string()).optional(),
  nutritional_info: z.array(z.object({ type: z.string(), name: z.string(), value: z.string() })).optional(),
  image_url: str,
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

export function detailProduct(p: Product, nutrition: Nutrient[] | undefined): z.infer<typeof productDetail> {
  const { regular, bonus } = productPrices(p);
  return {
    id: p.webshopId,
    title: p.title,
    url: productUrl(p.webshopId, p.title),
    brand: p.brand || undefined,
    category: p.mainCategory || undefined,
    description: p.descriptionHighlights || undefined,
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
    image_url: productImage(p) || undefined,
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
