import type { AhClient } from "./client.ts";

/** Delivery address, in the form orderDeliverySlots takes. */
export interface MemberAddress {
  street: string;
  houseNumber: number;
  houseNumberExtra?: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}

/** Customer profile. */
export interface Member {
  firstName: string;
  lastName: string;
  email: string;
  postalCode: string;
  bonusCardNumber: string;
  address?: MemberAddress;
}

/** "First Last", as AH shows it. */
export function fullName(m: Member): string {
  return `${m.firstName} ${m.lastName}`.trim();
}

export async function getMember(c: AhClient): Promise<Member> {
  const query = `query Member {
  member {
    name { first last }
    emailAddress
    address { street houseNumber houseNumberExtra postalCode city countryCode }
    cards { bonus }
  }
}`;
  const { member: m } = await c.graphql<{
    member: {
      name?: { first?: string; last?: string };
      emailAddress?: string;
      address?: Partial<MemberAddress> | null;
      cards?: { bonus?: string };
    };
  }>(query);
  return {
    firstName: m.name?.first ?? "",
    lastName: m.name?.last ?? "",
    email: m.emailAddress ?? "",
    postalCode: m.address?.postalCode ?? "",
    bonusCardNumber: m.cards?.bonus ?? "",
    address: isComplete(m.address) ? m.address : undefined,
  };
}

function isComplete(a: Partial<MemberAddress> | null | undefined): a is MemberAddress {
  return Boolean(a?.street && a.houseNumber && a.postalCode && a.city && a.countryCode);
}
