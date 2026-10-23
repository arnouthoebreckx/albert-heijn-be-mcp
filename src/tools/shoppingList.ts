import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addProductsToShoppingList,
  addTextToShoppingList,
  getShoppingList,
  isOrderMode,
  productsByIds,
  productUrl,
  removeFromShoppingList,
} from "../ahapi/index.ts";
import {
  addAuthedTool,
  confirmInput,
  itemText,
  MAX_ITEMS,
  MAX_QUANTITY,
  productItems,
  structured,
  text,
  type ToolContext,
  wrapError,
} from "./common.ts";

/** Replaces AH's "Server in order mode" error. */
const ORDER_MODE_MESSAGE =
  "the shopping list is not available while a delivery order is active: " +
  "AH moved its products into the order when the delivery slot was chosen. " +
  "Use ah_get_cart, ah_update_cart_item and ah_remove_from_cart to view or change the order";

/** Runs a shopping-list call; errors are prefixed with action, or replaced with ORDER_MODE_MESSAGE. */
export async function listCall<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw isOrderMode(err) ? new Error(ORDER_MODE_MESSAGE) : wrapError(action, err);
  }
}

export function registerShoppingListTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_shopping_list",
      title: "Albert Heijn: View Shopping List",
      kind: "readOnly",
      output: {
        items: z.array(
          z.object({
            position: z.number(),
            name: z.string(),
            product_id: z.number().optional(),
            url: z.string().optional(),
            quantity: z.number(),
            checked: z.boolean().optional(),
          }),
        ),
      },
      description:
        "Get the contents of the Albert Heijn shopping list (boodschappenlijst). " +
        "In the AH app this is the basket the user fills while shopping; choosing a delivery slot moves its products " +
        "into an order, after which the list is unavailable until the order is done (use ah_get_cart then). " +
        "Returns item names, quantities, and product IDs.",
    },
    async (c) => {
      const items = await listCall("failed to get shopping list", () => getShoppingList(c));
      return structured(
        {
          items: items.map((it) => ({
            position: it.position,
            name: it.name,
            product_id: it.productId || undefined,
            url: it.productId ? productUrl(it.productId, it.name) : undefined,
            quantity: it.quantity,
            checked: it.checked || undefined,
          })),
        },
        items.length ? undefined : "Your shopping list is empty.",
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_add_to_shopping_list",
      title: "Albert Heijn: Add to Shopping List",
      kind: "additive",
      description:
        "Add one or more products to your Albert Heijn shopping list. " +
        "Pass an array of items, each with product_id (int) and quantity (int). " +
        "Returns confirmation listing the names of successfully added products.",
      input: {
        items: productItems.describe('Items to add, e.g. [{"product_id": 123456, "quantity": 2}]'),
      },
    },
    async (c, { items }) => {
      const quantities = new Map<number, number>();
      for (const it of items) {
        if (it.product_id > 0 && it.quantity > 0) {
          quantities.set(it.product_id, (quantities.get(it.product_id) ?? 0) + it.quantity);
        }
      }
      if (quantities.size === 0) {
        throw new Error("no valid items provided (each item needs product_id > 0 and quantity > 0)");
      }
      for (const [id, qty] of quantities) {
        if (qty > MAX_QUANTITY) throw new Error(`product ${id} adds up to ${qty}; at most ${MAX_QUANTITY} per call`);
      }
      await listCall("failed to add items", () => addProductsToShoppingList(c, quantities));

      // Product names for the confirmation; IDs if the lookup fails.
      const names = new Map<number, string>();
      try {
        for (const p of await productsByIds(c, [...quantities.keys()])) names.set(p.webshopId, p.title);
      } catch {
        // Names are cosmetic.
      }
      const lines = [...quantities].map(([id, qty]) => `${names.get(id) ?? `Product ${id}`} (x${qty})`);
      return text(`Added to shopping list:\n- ${lines.join("\n- ")}`);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_add_free_text_to_shopping_list",
      title: "Albert Heijn: Add Free-Text to Shopping List",
      kind: "additive",
      description:
        "Add a free-text item to the Albert Heijn shopping list (no product ID needed). " +
        "Use for reminders like 'verse bloemen', 'any good wine', or items not found in search. " +
        "Free-text items have no quantity: put amounts in the text, e.g. '2 bossen bloemen'.",
      input: {
        name: itemText.describe("Free-text item description, e.g. 'verse bloemen', 'goede rode wijn'"),
      },
    },
    async (c, args) => {
      if (!args.name) throw new Error("name is required");
      await listCall("failed to add free-text item", () => addTextToShoppingList(c, args.name));
      return text(`Added '${args.name}' to shopping list.`);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_remove_from_shopping_list",
      title: "Albert Heijn: Remove from Shopping List",
      kind: "destructive",
      description:
        "Remove one or more items from the Albert Heijn Boodschappenlijst. " +
        "For product items pass product_ids; for free-text items pass names. " +
        "Get product_ids from ah_get_shopping_list.",
      input: {
        product_ids: z
          .array(z.number().int())
          .max(MAX_ITEMS)
          .optional()
          .describe("Product IDs to remove, e.g. [123456, 789012]. Use for product items."),
        names: z
          .array(z.string())
          .max(MAX_ITEMS)
          .optional()
          .describe('Free-text item names to remove, e.g. ["verse bloemen"]. Use for items without a product ID.'),
      },
    },
    async (c, args) => {
      const ids = new Set((args.product_ids ?? []).filter((id) => id > 0));
      const names = new Set((args.names ?? []).filter(Boolean).map((n) => n.toLowerCase()));
      if (ids.size === 0 && names.size === 0) throw new Error("provide at least one product_id or name to remove");

      const items = await listCall("failed to read shopping list", () => getShoppingList(c));
      const matches = items.filter(
        (it) => ids.has(it.productId) || (it.productId === 0 && names.has(it.name.toLowerCase())),
      );
      if (matches.length === 0) throw new Error("no matching items found on the shopping list");
      await listCall("failed to update shopping list", () => removeFromShoppingList(c, matches));
      return text(`Removed from shopping list: ${matches.map((it) => it.name).join(", ")}`);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_clear_shopping_list",
      title: "Albert Heijn: Clear Shopping List",
      kind: "destructive",
      description: 'Remove ALL items from the Albert Heijn shopping list. Irreversible — requires confirm="yes".',
      input: confirmInput,
    },
    async (c, { confirm }) => {
      if (confirm !== "yes") throw new Error('confirm must be "yes" to clear the shopping list');
      const items = await listCall("failed to read shopping list", () => getShoppingList(c));
      if (items.length === 0) return text("Shopping list is already empty.");
      await listCall("failed to clear shopping list", () => removeFromShoppingList(c, items));
      return text("Shopping list cleared.");
    },
  );
}
