import type { AhClient } from "./client.ts";

/** In-store receipt (kassabon) summary. */
export interface ReceiptSummary {
  id: string;
  dateTime: string; // ISO 8601
  total: number;
}

/** Most recent receipts, newest first. */
export async function getReceipts(c: AhClient, limit: number): Promise<ReceiptSummary[]> {
  const query = `query Receipts($limit: Int!) {
  posReceiptsPage(pagination: {offset: 0, limit: $limit}) {
    posReceipts { id dateTime totalAmount { amount } }
  }
}`;
  const data = await c.graphql<{
    posReceiptsPage: { posReceipts: { id: string; dateTime: string; totalAmount?: { amount: number } }[] | null };
  }>(query, { limit });
  return (data.posReceiptsPage.posReceipts ?? []).map((r) => ({
    id: r.id,
    dateTime: r.dateTime,
    total: r.totalAmount?.amount ?? 0,
  }));
}

export interface Receipt {
  id: string;
  items: { name: string; quantity: number; unitPrice?: number; total: number }[];
  discounts: { name: string; amount: number }[];
  payments: { method: string; amount: number }[];
}

export async function getReceipt(c: AhClient, id: string): Promise<Receipt> {
  const query = `query Receipt($id: String!) {
  posReceiptDetails(id: $id) {
    id
    products { name quantity price { amount } amount { amount } }
    discounts { name amount { amount } }
    payments { method amount { amount } }
  }
}`;
  type Money = { amount: number } | null;
  const { posReceiptDetails: d } = await c.graphql<{
    posReceiptDetails: {
      id: string;
      products?: { name: string; quantity: number; price?: Money; amount?: Money }[] | null;
      discounts?: { name: string; amount?: Money }[] | null;
      payments?: { method: string; amount?: Money }[] | null;
    };
  }>(query, { id });
  return {
    id: d.id,
    items: (d.products ?? []).map((p) => ({
      name: p.name,
      quantity: p.quantity,
      unitPrice: p.price?.amount,
      total: p.amount?.amount ?? 0,
    })),
    discounts: (d.discounts ?? []).map((x) => ({ name: x.name, amount: x.amount?.amount ?? 0 })),
    payments: (d.payments ?? []).map((x) => ({ method: x.method, amount: x.amount?.amount ?? 0 })),
  };
}
