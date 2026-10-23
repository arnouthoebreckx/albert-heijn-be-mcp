import { type AhClient, checkMutation, type MutationResult } from "./client.ts";

/** A named favourite list ("Mijn lijstjes"). */
export interface FavoriteList {
  id: string;
  name: string;
  itemCount: number;
  updatedAt?: string;
}

interface GqlFavoriteList {
  id: string;
  description: string;
  totalSize: number;
  updatedAt?: string;
}

function toFavoriteList(l: GqlFavoriteList): FavoriteList {
  return { id: l.id, name: l.description, itemCount: l.totalSize, updatedAt: l.updatedAt };
}

/** The lists with these ids; all lists if ids is empty. */
export async function getFavoriteLists(c: AhClient, ids: string[] = []): Promise<FavoriteList[]> {
  const query = `query FavoriteLists($ids: [String!]!) {
  favoriteListV2(ids: $ids) { id description totalSize updatedAt }
}`;
  const data = await c.graphql<{ favoriteListV2: GqlFavoriteList[] | null }>(query, { ids });
  return (data.favoriteListV2 ?? []).map(toFavoriteList);
}

/** Adds products (product ID → quantity), or updates quantities of ones already listed. */
export async function addToFavoriteList(c: AhClient, listId: string, quantities: Map<number, number>): Promise<void> {
  const mutation = `mutation AddToFavoriteList($id: String!, $products: [FavoriteListProductMutation!]!) {
  favoriteListProductsAddV2(id: $id, products: $products) { status errorMessage }
}`;
  const products = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
  const data = await c.graphql<{ favoriteListProductsAddV2: MutationResult }>(mutation, { id: listId, products });
  checkMutation(data.favoriteListProductsAddV2);
}

/** Removes products; returns how many were on the list. */
export async function removeFromFavoriteList(c: AhClient, listId: string, productIds: number[]): Promise<number> {
  // The delete mutation takes item IDs, not product IDs.
  const query = `query FavoriteListItems($ids: [String!]!) {
  favoriteListV2(ids: $ids) { items { id productId } }
}`;
  const lists = await c.graphql<{ favoriteListV2: { items: { id: string; productId: number }[] }[] | null }>(query, {
    ids: [listId],
  });
  const list = lists.favoriteListV2?.[0];
  if (!list) throw new Error(`favorite list ${listId} not found`);
  const remove = new Set(productIds);
  const itemIds = list.items.filter((it) => remove.has(it.productId)).map((it) => it.id);
  if (itemIds.length === 0) throw new Error("none of these products are on the favorite list");

  const mutation = `mutation RemoveFromFavoriteList($id: String!, $itemIds: [String!]!) {
  favoriteListProductsDeleteV2(id: $id, itemIds: $itemIds) { status errorMessage }
}`;
  const data = await c.graphql<{ favoriteListProductsDeleteV2: MutationResult }>(mutation, { id: listId, itemIds });
  checkMutation(data.favoriteListProductsDeleteV2);
  return itemIds.length;
}

/** Creates an empty favourite list. */
export async function createFavoriteList(c: AhClient, name: string): Promise<FavoriteList> {
  const mutation = `mutation CreateFavoriteList($name: String!) {
  favoriteListAddV2(description: $name) { status errorMessage result { id description totalSize } }
}`;
  const data = await c.graphql<{ favoriteListAddV2: MutationResult & { result?: GqlFavoriteList | null } }>(mutation, {
    name,
  });
  checkMutation(data.favoriteListAddV2);
  const l = data.favoriteListAddV2.result;
  if (!l) throw new Error("AH created the list but returned no list");
  return toFavoriteList(l);
}

/** Deletes a favourite list and its items. */
export async function deleteFavoriteList(c: AhClient, listId: string): Promise<void> {
  const mutation = `mutation DeleteFavoriteList($id: String!) {
  favoriteListDeleteV2(id: $id) { status errorMessage }
}`;
  const data = await c.graphql<{ favoriteListDeleteV2: MutationResult }>(mutation, { id: listId });
  checkMutation(data.favoriteListDeleteV2);
}
