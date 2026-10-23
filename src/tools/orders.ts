import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFulfillments, getOrderDetails, type Order, productUrl } from "../ahapi/index.ts";
import { log } from "../log.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, withRetry } from "./common.ts";
import { orderView, viewOrder } from "./views.ts";

/** Status of a cancelled order; AH reports statuses in Dutch ("Geannuleerd"). */
const CANCELLED = /geannuleerd|cancel/i;

export function registerOrderTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_orders",
      title: "Albert Heijn: Orders",
      kind: "readOnly",
      output: {
        orders: z.array(
          z.object({
            id: z.number(),
            date: z.string().optional(),
            time_window: z.string().optional(),
            total_price: z.number().optional(),
            status: z.string().optional(),
            shopping_type: z.string().optional(),
            modifiable: z.boolean().optional(),
          }),
        ),
      },
      description:
        "List Albert Heijn online delivery orders. " +
        "By default returns upcoming orders (with a modifiable flag); set past=true for delivered orders. " +
        "Returns id, date, time_window, total_price, status. " +
        "Use the returned id with ah_get_order_details to see the items.",
      input: {
        past: z.boolean().optional().describe("Return delivered orders instead of upcoming ones"),
        limit: z.number().int().optional().describe("Maximum number of orders to return (default 10)"),
      },
    },
    async (c, { past, limit }) => {
      const fulfillments = await getFulfillments(c, Boolean(past));
      const empty = past ? "No past orders found." : "No upcoming orders.";
      return structured(
        {
          orders: fulfillments.slice(0, orDefault(limit, 10)).map((f) => ({
            id: f.orderId,
            date: f.dateDisplay || f.date || undefined,
            time_window: f.timeDisplay || undefined,
            total_price: f.totalPrice ?? undefined,
            status: f.status,
            shopping_type: f.shoppingType || undefined,
            modifiable: past ? undefined : f.modifiable,
          })),
        },
        fulfillments.length ? undefined : empty,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_order_details",
      title: "Albert Heijn: Order Details",
      kind: "readOnly",
      output: orderView.shape,
      description:
        "Get the full item list for a specific Albert Heijn delivery order by its ID. " +
        "Returns all products with names, quantities, and prices. " +
        "Get order_id from ah_get_orders.",
      input: { order_id: z.number().int().describe("Numeric order ID from ah_get_orders") },
    },
    async (c, { order_id }) => {
      if (order_id <= 0) throw new Error("order_id is required");
      return structured(viewOrder(await getOrderDetails(c, order_id)));
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_frequent_items",
      title: "Albert Heijn: Frequently Ordered Items",
      kind: "readOnly",
      output: {
        products: z.array(
          z.object({
            product_name: z.string(),
            product_id: z.number(),
            order_count: z.number(),
            last_ordered_date: z.string().optional(),
            url: z.string(),
          }),
        ),
      },
      description:
        "Get frequently ordered products by analysing order history. " +
        "Fetches all fulfillments, expands each order's items, counts per product, " +
        "and returns products ordered at least min_order_count times. " +
        "Returns product_name, product_id, order_count, last_ordered_date.",
      input: {
        min_order_count: z
          .number()
          .int()
          .optional()
          .describe("Minimum number of orders a product must appear in (default 3)"),
      },
    },
    async (c, args) => {
      const minCount = orDefault(args.min_order_count, 3);
      const [open, closed] = await Promise.all([
        getFulfillments(c, false),
        nonFatal(
          () => getFulfillments(c, true),
          (err) => {
            // Continue with open orders only.
            log.warn("could not fetch past orders", { tool: "ah_get_frequent_items", err });
            return [];
          },
        ),
      ]);
      // Cancelled orders were never delivered, so they don't count as purchases.
      const refs = [...open, ...closed.filter((f) => !CANCELLED.test(f.status))];

      const orders: (Order | undefined)[] = new Array(refs.length);
      await parallel(refs.length, 5, async (i) => {
        const id = refs[i]!.orderId;
        orders[i] = await nonFatal(
          () => withRetry("ah_get_frequent_items", () => getOrderDetails(c, id)),
          (err) => {
            log.warn("could not fetch order", { tool: "ah_get_frequent_items", order_id: id, err });
            return undefined;
          },
        );
      });

      const stats = new Map<number, { product_name: string; product_id: number; order_count: number; last_ordered_date: string }>();
      orders.forEach((order, i) => {
        if (!order) return;
        const date = refs[i]!.date ?? "";
        // First title per product; an order lists a product at most once in the count.
        const titles = new Map<number, string>();
        for (const it of order.items) if (!titles.has(it.productId)) titles.set(it.productId, it.title);
        for (const [productId, title] of titles) {
          const name = title || String(productId);
          let s = stats.get(productId);
          if (!s) {
            s = { product_name: name, product_id: productId, order_count: 0, last_ordered_date: "" };
            stats.set(productId, s);
          }
          s.order_count++;
          if (date > s.last_ordered_date) {
            s.last_ordered_date = date;
            s.product_name = name;
          }
        }
      });
      return structured({
        products: [...stats.values()]
          .filter((s) => s.order_count >= minCount)
          .sort((a, b) => b.order_count - a.order_count)
          .map((s) => ({
            ...s,
            url: productUrl(s.product_id, s.product_name),
            last_ordered_date: s.last_ordered_date || undefined,
          })),
      });
    },
  );
}
