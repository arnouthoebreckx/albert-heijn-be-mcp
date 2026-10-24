import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAnonymous } from "../auth/anonymous.ts";
import { registerAccountTools } from "./account.ts";
import { registerBonusTools } from "./bonus.ts";
import { registerCartTools } from "./cart.ts";
import type { ToolContext } from "./common.ts";
import { registerFavoriteListTools } from "./favorites.ts";
import { registerOrderTools } from "./orders.ts";
import { registerProductTools } from "./products.ts";
import { registerReceiptTools } from "./receipts.ts";
import { registerRecipeTools } from "./recipes.ts";
import { registerShoppingListTools } from "./shoppingList.ts";
import { registerStoreTools } from "./stores.ts";

export { newToolContext, type ToolContext } from "./common.ts";

/**
 * The tools of anonymous mode (spec section 2): the four that are required, and the optional ones that
 * work on ah.be without a login. Any other tool is never registered, so a new one starts out hidden.
 */
const ANONYMOUS_TOOLS = new Set([
  "ah_search_products",
  "ah_get_products",
  "ah_get_bonus_offers",
  "ah_get_bonus_group_products",
  "ah_get_product_alternatives",
  "ah_search_recipes",
  "ah_get_recipe",
]);

/** The server, but registering only these tools. The tool groups register through registerTool alone (addTool). */
function only(server: McpServer, names: Set<string>): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (name: string, ...args: unknown[]) => (names.has(name) ? Reflect.apply(target.registerTool, target, [name, ...args]) : undefined);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  if (isAnonymous(ctx.clients)) server = only(server, ANONYMOUS_TOOLS);
  registerAccountTools(server, ctx);
  registerProductTools(server, ctx);
  registerBonusTools(server, ctx);
  registerRecipeTools(server, ctx);
  registerStoreTools(server, ctx);
  registerShoppingListTools(server, ctx);
  registerFavoriteListTools(server, ctx);
  registerCartTools(server, ctx);
  registerOrderTools(server, ctx);
  registerReceiptTools(server, ctx);
}
