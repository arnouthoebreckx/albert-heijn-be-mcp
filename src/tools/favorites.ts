import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addToFavoriteList,
  createFavoriteList,
  deleteFavoriteList,
  getFavoriteLists,
  GraphQLError,
  removeFromFavoriteList,
} from "../ahapi/index.ts";
import {
  addAuthedTool,
  confirmInput,
  itemText,
  orDefault,
  productItems,
  structured,
  text,
  type ToolContext,
  withRetry,
} from "./common.ts";
import { favoriteListView, viewFavoriteList } from "./views.ts";

const listId = z.string().describe("Favorite list ID from ah_get_favorite_lists");

export function registerFavoriteListTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_favorite_lists",
      title: "Albert Heijn: View Favourite Lists",
      kind: "readOnly",
      output: { lists: z.array(favoriteListView) },
      description:
        "List all Albert Heijn favorite/saved shopping lists with their names and item counts. " +
        "Use the returned list ID with ah_add_to_favorite_list, ah_remove_from_favorite_list or ah_delete_favorite_list.",
    },
    async (c) => {
      const lists = await getFavoriteLists(c);
      return structured({ lists: lists.map(viewFavoriteList) }, lists.length ? undefined : "You have no favorite lists.");
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_add_to_favorite_list",
      title: "Albert Heijn: Add to Favourite List",
      kind: "additive",
      description: "Add products to a named Albert Heijn favorite list. Get list_id from ah_get_favorite_lists.",
      input: {
        list_id: listId,
        items: productItems.describe('Items to add, e.g. [{"product_id": 123456, "quantity": 1}]. Quantity 0 is treated as 1.'),
      },
    },
    async (c, args) => {
      if (!args.list_id) throw new Error("list_id is required");
      const quantities = new Map<number, number>();
      for (const it of args.items) if (it.product_id > 0) quantities.set(it.product_id, orDefault(it.quantity, 1));
      if (quantities.size === 0) throw new Error("no valid items provided");
      await addToFavoriteList(c, args.list_id, quantities);
      return text(`Added ${quantities.size} item(s) to favorite list ${args.list_id}.`);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_remove_from_favorite_list",
      title: "Albert Heijn: Remove from Favourite List",
      kind: "destructive",
      description: "Remove products from a named Albert Heijn favorite list. Get list_id from ah_get_favorite_lists.",
      input: {
        list_id: listId,
        product_ids: z.array(z.number().int()).describe("Product IDs to remove, e.g. [123456, 789012]"),
      },
    },
    async (c, args) => {
      if (!args.list_id) throw new Error("list_id is required");
      const ids = args.product_ids.filter((id) => id > 0);
      if (ids.length === 0) throw new Error("no valid product_ids provided");
      const removed = await removeFromFavoriteList(c, args.list_id, ids);
      return text(`Removed ${removed} product(s) from favorite list ${args.list_id}.`);
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_create_favorite_list",
      title: "Albert Heijn: Create Favourite List",
      kind: "additive",
      output: favoriteListView.shape,
      description:
        "Create a new, empty Albert Heijn favorite list with the given name; AH drops some punctuation, such as '-'. " +
        "Returns its id; add products with ah_add_to_favorite_list.",
      input: { name: itemText.describe("Name of the list, e.g. 'Weekend' or 'Pasta night'") },
    },
    async (c, args) => {
      const name = args.name.trim();
      if (!name) throw new Error("name is required");
      return structured(viewFavoriteList(await createFavoriteList(c, name)));
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_delete_favorite_list",
      title: "Albert Heijn: Delete Favourite List",
      kind: "destructive",
      description:
        'Delete an Albert Heijn favorite list and everything on it. Irreversible — requires confirm="yes". ' +
        "Get list_id from ah_get_favorite_lists.",
      input: { list_id: listId, ...confirmInput },
    },
    async (c, args) => {
      if (args.confirm !== "yes") throw new Error('confirm must be "yes" to delete the list');
      if (!args.list_id) throw new Error("list_id is required");
      // AH answers an unknown id with the same redacted error as an outage; all lists tells them apart.
      const list = await withRetry("ah_delete_favorite_list", async () => {
        try {
          return (await getFavoriteLists(c, [args.list_id]))[0];
        } catch (err) {
          if (!(err instanceof GraphQLError)) throw err;
          return (await getFavoriteLists(c)).find((l) => l.id === args.list_id);
        }
      });
      if (!list) throw new Error(`favorite list ${args.list_id} not found`);
      await deleteFavoriteList(c, list.id);
      return text(`Deleted favorite list "${list.name}" (${list.itemCount} items).`);
    },
  );
}
