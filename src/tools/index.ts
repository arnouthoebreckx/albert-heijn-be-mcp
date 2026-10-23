import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export function registerTools(server: McpServer, ctx: ToolContext): void {
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
