import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AhClient, getBargains, productUrl, searchStores } from "../ahapi/index.ts";
import { addAuthedTool, cachedMember, formatDate, orDefault, structured, type ToolContext, wrapError } from "./common.ts";

const str = z.string().optional();

export function registerStoreTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_search_stores",
      title: "Albert Heijn: Search Stores",
      kind: "readOnly",
      output: {
        stores: z.array(
          z.object({ id: z.number(), name: z.string(), type: str, street: str, city: str, postal_code: str }),
        ),
      },
      description:
        "Find Albert Heijn stores near a Dutch postal code. " +
        "If no postal_code is given, automatically uses the address from the member profile. " +
        "Returns store id (use this for ah_get_last_chance_items), name, type, and address.",
      input: {
        postal_code: z
          .string()
          .optional()
          .describe("Dutch postal code, e.g. '1234AB'. Optional — falls back to member address."),
      },
    },
    async (c, { postal_code }) => {
      const postalCode = postal_code || (await memberPostalCode(ctx, c));
      if (!postalCode) throw new Error("no postal_code provided and member profile has no address on file");
      const stores = await searchStores(c, postalCode);
      return structured(
        {
          stores: stores.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.storeType || undefined,
            street: [s.address?.street, s.address?.houseNumber].filter(Boolean).join(" ") || undefined,
            city: s.address?.city || undefined,
            postal_code: s.address?.postalCode || undefined,
          })),
        },
        stores.length ? undefined : `No AH stores found near ${postalCode}.`,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_last_chance_items",
      title: "Albert Heijn: Last-Chance Items",
      kind: "readOnly",
      output: {
        items: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            url: z.string(),
            brand: str,
            category: str,
            markdown_type: str,
            discount_percentage: z.number().optional(),
            expiration_date: str,
            stock: z.number().optional(),
            price_was: str,
            price_now: str,
          }),
        ),
      },
      description:
        "Get last-chance / vandaag-af / clearance items from an Albert Heijn store. " +
        "Requires a store_id (use ah_search_stores to find stores, or provide postal_code to find the nearest store). " +
        "Uses the dedicated bargainItems GraphQL endpoint which returns today-only markdown deals.",
      input: {
        limit: z.number().int().optional().describe("Maximum number of results to return (default 20)"),
        store_id: z.number().int().optional().describe("AH store ID. Required to retrieve bargain items."),
        postal_code: z
          .string()
          .optional()
          .describe("Dutch postal code (e.g. '1234AB') to find the nearest store when store_id is not known."),
      },
    },
    async (c, args) => {
      const storeId = args.store_id || (await nearestStoreId(ctx, c, args.postal_code));
      if (!storeId) {
        throw new Error(
          "cannot retrieve last-chance items without a store. Please provide store_id or postal_code. " +
            'Example: {"store_id": 1234} or {"postal_code": "1011AB"}',
        );
      }
      const bargains = (await getBargains(c, storeId)).slice(0, orDefault(args.limit, 20));
      return structured({
        items: bargains.map((b) => ({
          id: b.productId,
          title: b.title,
          url: productUrl(b.productId, b.title),
          brand: b.brand || undefined,
          category: b.category || undefined,
          markdown_type: b.markdownType || undefined,
          discount_percentage: b.discount || undefined,
          expiration_date: formatDate(b.expirationDate, false) || undefined,
          stock: b.stock || undefined,
          price_was: b.priceWas || undefined,
          price_now: b.priceNow ?? undefined,
        })),
      });
    },
  );
}

/** The member's postal code, or "" if none is on file. */
async function memberPostalCode(ctx: ToolContext, c: AhClient): Promise<string> {
  try {
    return (await cachedMember(ctx, c)).postalCode;
  } catch (err) {
    throw wrapError("no postal_code provided and could not fetch member address", err);
  }
}

/** Nearest store to postalCode (default: member address), or 0 if there is no address or store. */
async function nearestStoreId(ctx: ToolContext, c: AhClient, postalCode: string | undefined): Promise<number> {
  const code = postalCode || (await memberPostalCode(ctx, c));
  if (!code) return 0;
  return (await searchStores(c, code))[0]?.id ?? 0;
}
