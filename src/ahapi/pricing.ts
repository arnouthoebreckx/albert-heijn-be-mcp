// One meaning for prices (spec 2a, A2): what one pack costs, and what a deal costs, from the mechanism text.
// AH sends the same mechanism text with prices for a different number of packs, depending on where the row
// comes from, so the parser takes the source of the row too. Where it cannot tell, every deal field is null.

/** Where a row comes from, which says what its two prices are for. */
export type PriceSource =
  /** A product of a bonus section: the prices of the packs the deal needs, and what they cost with the deal. */
  | "section"
  /** The example product of a group offer: the same as a section product. */
  | "example"
  /** A row of search, product details or a group: priceBeforeBonus is one pack. */
  | "search";

export interface PriceFields {
  pack_price: number | null;
  deal_min_quantity: number | null;
  deal_total: number | null;
  deal_price_per_pack: number | null;
  unit_price: number | null;
  unit_price_unit: "kg" | "l" | "stuk" | null;
}

/** The fields that stay null in a tool result, where other null values from AH are left out. */
export const PRICE_FIELD_NAMES: ReadonlySet<string> = new Set<keyof PriceFields>([
  "pack_price",
  "deal_min_quantity",
  "deal_total",
  "deal_price_per_pack",
  "unit_price",
  "unit_price_unit",
]);

export interface PriceRow {
  source: PriceSource;
  /** AH's bonusMechanism, or a group's discountDescription. */
  mechanism?: string | null;
  /** priceBeforeBonus, or a group's exampleFromPrice. */
  was?: number | null;
  /** currentPrice, or a group's exampleForPrice. */
  now?: number | null;
  /** AH's unitPriceDescription, e.g. "normale prijs per kg €8.63". */
  unitPriceDescription?: string | null;
  /** AH sells the row as one item made of several (isVirtualBundle). */
  bundle?: boolean;
}

/** Amounts are worked out in cents, which keeps the rounding exact. */
const toCents = (euros: number) => Math.round(euros * 100);
const toEuros = (cents: number) => cents / 100;

/** Half of an amount in cents, to the even cent: AH rounds 3.745 to 3.74 and 1.045 to 1.04. */
function halfEven(cents: number): number {
  const down = Math.floor(cents / 2);
  return cents % 2 === 0 || down % 2 === 0 ? down : down + 1;
}

interface Deal {
  /** Packs the deal needs. */
  quantity: number;
  /** What those packs cost with the deal, in cents, for a pack of this many cents. */
  total(pack: number): number;
  /** The text does not say how many packs it needs: only a row AH sells as one item is known. */
  volume?: boolean;
}

/** The deal a mechanism text stands for, or undefined for a text this does not know. */
function parseMechanism(text: string | null | undefined): Deal | undefined {
  const t = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d+) ?\+ ?(\d+) gratis$/))) {
    const [pay, free] = [Number(m[1]), Number(m[2])];
    return { quantity: pay + free, total: (pack) => pack * pay };
  }
  if ((m = t.match(/^(\d+)e gratis$/))) {
    const k = Number(m[1]);
    return k >= 2 ? { quantity: k, total: (pack) => pack * (k - 1) } : undefined;
  }
  if ((m = t.match(/^(\d+)e halve prijs$/))) {
    const k = Number(m[1]);
    return k >= 2 ? { quantity: k, total: (pack) => pack * (k - 1) + halfEven(pack) } : undefined;
  }
  if ((m = t.match(/^(\d+) voor (\d+(?:[.,]\d+)?)$/))) {
    const total = toCents(Number(m[2]!.replace(",", ".")));
    return { quantity: Number(m[1]), total: () => total };
  }
  if ((m = t.match(/^voor (\d+(?:[.,]\d+)?)$/))) {
    const total = toCents(Number(m[1]!.replace(",", ".")));
    return { quantity: 1, total: () => total };
  }
  if ((m = t.match(/^(\d+)% (korting|volume voordeel)$/))) {
    const percent = Number(m[1]);
    return { quantity: 1, total: (pack) => Math.round((pack * (100 - percent)) / 100), volume: m[2] === "volume voordeel" };
  }
  if ((m = t.match(/^(\d+) euro korting$/))) {
    const euros = Number(m[1]);
    return { quantity: 1, total: (pack) => pack - euros * 100 };
  }
  return undefined;
}

const UNITS = { kg: "kg", liter: "l", stuk: "stuk" } as const;

/** "normale prijs per kg €8.63" → 8.63 per kg; null for text that is not a price per kg, liter or stuk. */
function parseUnitPrice(text: string | null | undefined): Pick<PriceFields, "unit_price" | "unit_price_unit"> {
  const m = (text ?? "").match(/\bper (kg|liter|stuk) *€ *(\d+(?:[.,]\d+)?)\s*$/i);
  if (!m) return { unit_price: null, unit_price_unit: null };
  return { unit_price: Number(m[2]!.replace(",", ".")), unit_price_unit: UNITS[m[1]!.toLowerCase() as keyof typeof UNITS] };
}

/** The six price fields of a row. Never a guess: a row the parser cannot read gives null for what it cannot tell. */
export function priceFields(row: PriceRow): PriceFields {
  const unit = parseUnitPrice(row.unitPriceDescription);
  const none = (pack: number | null): PriceFields => ({ pack_price: pack, deal_min_quantity: null, deal_total: null, deal_price_per_pack: null, ...unit });
  const deal = parseMechanism(row.mechanism);
  const known = (pack: number, quantity: number, total: number): PriceFields => ({
    pack_price: toEuros(pack),
    deal_min_quantity: quantity,
    deal_total: toEuros(total),
    deal_price_per_pack: toEuros(Math.round(total / quantity)),
    ...unit,
  });
  const was = row.was ?? null;
  const now = row.now ?? null;

  if (row.source === "search") {
    if (was === null) return none(null);
    if (!deal) return none(was);
    const pack = toCents(was);
    const total = deal.total(pack);
    if (deal.volume && (row.bundle !== true || now === null)) return none(was);
    if (deal.quantity === 1 && now !== null) {
      // A single-pack deal says what AH charges now: AH's price when the text agrees with it, else neither is trusted.
      return Math.abs(total - toCents(now)) > 1 ? none(was) : known(pack, 1, toCents(now));
    }
    return known(pack, deal.quantity, total);
  }

  // A section product or a group example: the two prices are for the packs the deal needs. The mechanism and
  // the pair must agree, which is also what shows the pair is for that many packs.
  if (!deal || deal.volume || was === null || now === null) return none(null);
  const pack = Math.round(toCents(was) / deal.quantity);
  if (Math.abs(deal.total(pack) - toCents(now)) > 1) return none(null);
  return known(pack, deal.quantity, toCents(now));
}
