import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { addDaysKey, todayKey } from "@/lib/dates";
import { publicToken } from "@/lib/public-token";
import { clientCreateSchema } from "@/lib/validators/client";
import { leadSchema } from "@/lib/validators/lead";
import { offerSchema } from "@/lib/validators/offer";
import { createClient } from "@/server/services/clients";
import { createLead } from "@/server/services/leads";
import {
  acceptOfferViaLink,
  changeOfferStatus,
  createOffer,
  ensureOfferLink,
  findOfferLink,
  markOfferSent,
  prepareForSending,
  revokeOfferLinks,
} from "@/server/services/offers";

/**
 * The connected sales flow (Batch A): lead → offer → sent → accepted → client, and rejected → Lost.
 */
const db = new PrismaClient();
let actorId: string;
const TODAY = todayKey();
const FOLLOW_UP = addDaysKey(TODAY, 3);

const offerInput = (who: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  offerSchema.parse({
    ...who,
    title: "Retainer", offerDate: TODAY, validUntil: addDaysKey(TODAY, 15), gstEnabled: true, milestones: [],
    items: [{ description: "Social media", billingType: "MONTHLY_RETAINER", quantity: "1", unit: "month", rate: "25000", gstRate: "18" }],
    ...over,
  });

const newLead = (over: Record<string, unknown> = {}) =>
  createLead(db, leadSchema.parse({ contactName: "Ravi Patil", companyName: "Patil Motors", phone: "9822000111", email: "ravi@patilmotors.in", city: "Chakan", servicesInterested: [], ...over }), actorId);

const newClient = (over: Record<string, unknown> = {}) =>
  createClient(db, clientCreateSchema.parse({ companyName: "Existing Co", contactName: "Someone", country: "India", stateCode: "27", status: "ACTIVE", ...over }), actorId);

/** A lead's offer, sent, with its client link. */
async function sentLeadOffer(leadId: string, over: Record<string, unknown> = {}) {
  const offer = await createOffer(db, offerInput({ leadId }, over), actorId);
  const link = await prepareForSending(db, offer.id, actorId);
  await markOfferSent(db, { offerId: offer.id, followUpDate: FOLLOW_UP, actorId, via: "email" });
  return { offer, token: publicToken(link.id) };
}

const leadNow = (id: string) => db.lead.findUniqueOrThrow({ where: { id }, include: { stageHistory: { orderBy: { createdAt: "asc" } } } });

beforeAll(async () => {
  await db.settings.upsert({ where: { id: "agency" }, update: { stateCode: "27", offerValidityDays: 15 }, create: { id: "agency", agencyName: "Test", address: "Pune", stateCode: "27" } });
  const user = await db.user.upsert({ where: { email: "flow-sales@example.com" }, update: {}, create: { name: "Flow Tester", email: "flow-sales@example.com", passwordHash: "x", role: "ADMIN" } });
  actorId = user.id;
});

beforeEach(async () => {
  await db.invoiceRun.deleteMany();
  await db.paymentAllocation.deleteMany();
  await db.payment.deleteMany();
  await db.creditNote.deleteMany();
  await db.invoiceItem.deleteMany();
  await db.invoice.updateMany({ data: { convertedFromId: null } });
  await db.invoice.deleteMany();
  await db.notification.deleteMany();
  await db.publicLink.deleteMany();
  await db.onboardingChecklist.deleteMany();
  await db.task.deleteMany();
  await db.project.deleteMany();
  await db.offerItem.deleteMany();
  await db.offer.deleteMany();
  await db.communicationLog.deleteMany();
  await db.lead.deleteMany();
  await db.client.deleteMany();
  await db.activityLog.deleteMany();
  await db.numberSequence.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("accepted offer → lead becomes a client automatically", () => {
  it("via the client's link: new client from the lead, lead Won, offer linked, onboarding started, you're told", async () => {
    const lead = await newLead();
    const { offer, token } = await sentLeadOffer(lead.id, { supplyStateCode: "29" });
    expect((await leadNow(lead.id)).stage).toBe("OFFER_SENT");

    await acceptOfferViaLink(db, { token, name: "Ravi Patil", ip: "1.2.3.4" });

    const after = await leadNow(lead.id);
    expect(after.stage).toBe("WON");
    expect(after.convertedAt).toBeTruthy();
    expect(after.stageHistory.at(-1)).toMatchObject({ fromStage: "OFFER_SENT", toStage: "WON", changedById: null });
    expect(after.stageHistory.at(-1)?.note).toMatch(/accepted, converted automatically/);

    const client = await db.client.findUniqueOrThrow({ where: { id: after.convertedClientId! }, include: { contacts: true } });
    // Details carried from the lead; the state is the one quoted on the offer, so GST matches.
    expect(client).toMatchObject({ companyName: "Patil Motors", phone: "9822000111", email: "ravi@patilmotors.in", city: "Chakan", stateCode: "29", status: "ACTIVE" });
    expect(client.contacts).toEqual([expect.objectContaining({ name: "Ravi Patil", isPrimary: true })]);

    expect((await db.offer.findUniqueOrThrow({ where: { id: offer.id } })).clientId).toBe(client.id);
    expect(await db.onboardingChecklist.count({ where: { offerId: offer.id, clientId: client.id } })).toBe(1);
    expect(await db.notification.count({ where: { userId: actorId, title: "New client: Patil Motors" } })).toBe(1);
    expect(await db.activityLog.count({ where: { action: "lead.converted", entityId: lead.id } })).toBe(1);
  });

  it("when you mark it accepted: same conversion, and the result is returned for the message", async () => {
    const lead = await newLead();
    const { offer } = await sentLeadOffer(lead.id);
    const { conversion } = await changeOfferStatus(db, { offerId: offer.id, to: "ACCEPTED", acceptedByName: "Ravi", actorId });
    expect(conversion).toMatchObject({ result: "created", clientName: "Patil Motors" });
    const after = await leadNow(lead.id);
    expect(after.stage).toBe("WON");
    expect(after.stageHistory.at(-1)?.changedById).toBe(actorId);
  });

  it("links to the one existing client with the same phone instead of making a duplicate", async () => {
    const existing = await newClient({ companyName: "Patil Motors Pvt Ltd", phone: "+91 98220 00111" });
    const lead = await newLead();
    const { offer, token } = await sentLeadOffer(lead.id);
    await acceptOfferViaLink(db, { token, name: "Ravi", ip: "1.2.3.4" });

    expect((await leadNow(lead.id)).convertedClientId).toBe(existing.id);
    expect(await db.client.count()).toBe(1);
    expect((await db.offer.findUniqueOrThrow({ where: { id: offer.id } })).clientId).toBe(existing.id);
    expect(await db.notification.count({ where: { userId: actorId, title: "Lead linked to Patil Motors Pvt Ltd" } })).toBe(1);
  });

  it("doesn't guess when several clients match: the lead stays, and you're asked to convert by hand", async () => {
    await newClient({ companyName: "Branch A", phone: "9822000111" });
    await newClient({ companyName: "Branch B", email: "ravi@patilmotors.in" });
    const lead = await newLead();
    const { offer } = await sentLeadOffer(lead.id);
    const { conversion } = await changeOfferStatus(db, { offerId: offer.id, to: "ACCEPTED", acceptedByName: "Ravi", actorId });

    expect(conversion).toMatchObject({ result: "needs_review" });
    const after = await leadNow(lead.id);
    expect(after.convertedClientId).toBeNull();
    expect(after.stage).toBe("OFFER_SENT");
    expect((await db.offer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("ACCEPTED");
    expect(await db.client.count()).toBe(2);
    const note = await db.notification.findFirstOrThrow({ where: { userId: actorId, title: { startsWith: "Convert the lead" } } });
    expect(note.href).toBe(`/leads/${lead.id}/convert`);
    expect(note.body).toMatch(/Branch A.*Branch B|Branch B.*Branch A/);
  });

  it("doesn't link to an archived client", async () => {
    const old = await newClient({ phone: "9822000111" });
    await db.client.update({ where: { id: old.id }, data: { archivedAt: new Date(), status: "ARCHIVED" } });
    const lead = await newLead();
    const { offer } = await sentLeadOffer(lead.id);
    const { conversion } = await changeOfferStatus(db, { offerId: offer.id, to: "ACCEPTED", acceptedByName: "Ravi", actorId });
    expect(conversion).toMatchObject({ result: "needs_review" });
    expect((await leadNow(lead.id)).convertedClientId).toBeNull();
  });

  it("offers to an existing client need no lead update", async () => {
    const c = await newClient({ phone: "9000000009" });
    const offer = await createOffer(db, offerInput({ clientId: c.id }), actorId);
    await prepareForSending(db, offer.id, actorId);
    await markOfferSent(db, { offerId: offer.id, followUpDate: FOLLOW_UP, actorId, via: "email" });
    const { conversion } = await changeOfferStatus(db, { offerId: offer.id, to: "ACCEPTED", acceptedByName: "Asha", actorId });
    expect(conversion.result).toBe("none");
    expect(await db.client.count()).toBe(1);
  });

  it("two accepts at the same moment convert the lead only once", async () => {
    const lead = await newLead();
    const { token } = await sentLeadOffer(lead.id);
    const results = await Promise.allSettled([1, 2, 3].map(() => acceptOfferViaLink(db, { token, name: "Ravi", ip: "1.1.1.1" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.client.count()).toBe(1);
    expect((await leadNow(lead.id)).stage).toBe("WON");
  });
});

describe("rejected offer → lead Lost", () => {
  it("marks the lead Lost with the same reason when it has no other open offer", async () => {
    const lead = await newLead();
    const { offer } = await sentLeadOffer(lead.id);
    await changeOfferStatus(db, { offerId: offer.id, to: "REJECTED", reason: "Went with a cheaper agency", actorId });
    const after = await leadNow(lead.id);
    expect(after).toMatchObject({ stage: "LOST", lostReason: "Went with a cheaper agency", nextFollowUpDate: null });
    expect(after.stageHistory.at(-1)).toMatchObject({ fromStage: "OFFER_SENT", toStage: "LOST" });
  });

  it("leaves the lead open while another offer is still open", async () => {
    const lead = await newLead();
    const { offer } = await sentLeadOffer(lead.id);
    await createOffer(db, offerInput({ leadId: lead.id }, { title: "Cheaper option" }), actorId); // a draft is still open
    await changeOfferStatus(db, { offerId: offer.id, to: "REJECTED", reason: "Too costly", actorId });
    expect((await leadNow(lead.id)).stage).toBe("OFFER_SENT");
  });

  it("an archived open offer doesn't keep the lead open", async () => {
    const lead = await newLead();
    const { offer } = await sentLeadOffer(lead.id);
    const old = await createOffer(db, offerInput({ leadId: lead.id }), actorId);
    await db.offer.update({ where: { id: old.id }, data: { archivedAt: new Date() } });
    await changeOfferStatus(db, { offerId: offer.id, to: "REJECTED", reason: "No budget", actorId });
    expect((await leadNow(lead.id)).stage).toBe("LOST");
  });
});

describe("revoking the client link", () => {
  it("stops the old link at once; sharing again makes a new link that works", async () => {
    const lead = await newLead();
    const { offer, token } = await sentLeadOffer(lead.id);
    expect(await revokeOfferLinks(db, offer.id, actorId)).toBe(1);

    expect((await findOfferLink(db, token))?.revokedAt).toBeTruthy();
    await expect(acceptOfferViaLink(db, { token, name: "Ravi", ip: "1.1.1.1" })).rejects.toThrow(/no longer valid/);
    await expect(revokeOfferLinks(db, offer.id, actorId)).rejects.toThrow(/no active client link/);

    const fresh = await ensureOfferLink(db, offer.id, actorId);
    const freshToken = publicToken(fresh.id);
    expect(freshToken).not.toBe(token);
    await acceptOfferViaLink(db, { token: freshToken, name: "Ravi", ip: "1.1.1.1" });
    expect((await leadNow(lead.id)).stage).toBe("WON");
    expect(await db.activityLog.count({ where: { action: "offer.link_revoked", entityId: offer.id } })).toBe(1);
  });
});
