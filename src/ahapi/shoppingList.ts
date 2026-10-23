import type { AhClient } from "./client.ts";

/** Shopping list (boodschappenlijst). Returns "Server in order mode" while a delivery order is active. */
const SHOPPING_LIST_PATH = "/mobile-services/shoppinglist/v2/items";

/** Product or free-text list item. */
export interface ListItem {
  /** 0 for free-text items. */
  productId: number;
  /** Product title or free text. */
  name: string;
  quantity: number;
  position: number;
  checked: boolean;
  /** Fields needed to remove the item. */
  raw: { type?: string; originCode?: string; description?: string };
}

/** Reports whether err is the "Server in order mode" response. */
export function isOrderMode(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Server in order mode");
}

export async function getShoppingList(c: AhClient): Promise<ListItem[]> {
  const res = await c.request<{
    items?: {
      position: number;
      quantity: number;
      strikedthrough?: boolean;
      type?: string;
      originCode?: string;
      description?: string;
      productDetails?: { product?: { webshopId?: number; title?: string } };
    }[];
  }>(SHOPPING_LIST_PATH);
  return (res.items ?? []).map((it) => {
    const product = it.productDetails?.product;
    return {
      productId: product?.webshopId ?? 0,
      name: product?.title || it.description || "",
      quantity: it.quantity,
      position: it.position,
      checked: it.strikedthrough ?? false,
      raw: { type: it.type, originCode: it.originCode, description: it.description },
    };
  });
}

/** PATCH item. AH rejects the request ("Failed to read request") unless every field is present. */
interface ListPatchItem {
  description: string;
  productId?: number;
  quantity: number;
  type: string;
  originCode: string;
  strikeThrough: boolean;
}

function patchShoppingList(c: AhClient, items: ListPatchItem[]): Promise<void> {
  return c.request<void>(SHOPPING_LIST_PATH, { method: "PATCH", body: { items } });
}

/**
 * Adds products (product ID → units to add). The PATCH sets quantities rather
 * than adding to them, so products already on the list are sent with their
 * current quantity plus the units added.
 */
export async function addProductsToShoppingList(c: AhClient, quantities: Map<number, number>): Promise<void> {
  const current = new Map((await getShoppingList(c)).filter((it) => it.productId).map((it) => [it.productId, it.quantity]));
  const items = [...quantities].map(([productId, quantity]) => ({
    description: "",
    productId,
    quantity: (current.get(productId) ?? 0) + quantity,
    type: "SHOPPABLE",
    originCode: "PRD",
    strikeThrough: false,
  }));
  return patchShoppingList(c, items);
}

/** Adds a free-text item. AH stores free-text items with quantity 1 and ignores other quantities. */
export function addTextToShoppingList(c: AhClient, text: string): Promise<void> {
  return patchShoppingList(c, [{ description: text, quantity: 1, type: "SHOPPABLE", originCode: "PRD", strikeThrough: false }]);
}

/** Removes items from getShoppingList by setting their quantity to 0. */
export function removeFromShoppingList(c: AhClient, items: ListItem[]): Promise<void> {
  return patchShoppingList(
    c,
    items.map((it) => ({
      // AH matches product items by productId and free-text items by description.
      // GET omits type and originCode; use the values sent when adding.
      description: it.raw.description || it.name,
      ...(it.productId ? { productId: it.productId } : {}),
      quantity: 0,
      type: it.raw.type || "SHOPPABLE",
      originCode: it.raw.originCode || "PRD",
      strikeThrough: false,
    })),
  );
}
