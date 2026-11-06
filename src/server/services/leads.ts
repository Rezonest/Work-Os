import type { Prisma } from "@prisma/client";
import { keyToDate } from "@/lib/dates";
import { stageChangeError, type LeadStage } from "@/lib/lead-stage";
import { findDuplicates } from "@/lib/contact-match";
import { clientCreateSchema, type ClientCreateData } from "@/lib/validators/client";
import type { LeadData } from "@/lib/validators/lead";
import { createClientInTx } from "./clients";
import { ensureOfferOnboarding } from "./onboarding";
import { BusinessError, diffChanges, loadContactables, logActivity, type Db, type Tx } from "./shared";

const LEAD_FIELDS = [
  "contactName", "companyName", "phone", "whatsapp", "email", "sectorId", "city", "leadSourceId",
  "servicesInterested", "approxBudget", "requirementNotes", "nextFollowUpDate", "ownerId",
] as const;

function leadColumns(d: LeadData) {
  return {
    contactName: d.contactName,
    companyName: d.companyName,
    phone: d.phone,
    whatsapp: d.whatsapp,
    email: d.email,
    sectorId: d.sectorId,
    city: d.city,
    leadSourceId: d.leadSourceId,
    servicesInterested: d.servicesInterested,
    approxBudget: d.approxBudget,
    requirementNotes: d.requirementNotes,
    nextFollowUpDate: d.nextFollowUpDate ? keyToDate(d.nextFollowUpDate) : null,
    ownerId: d.ownerId,
  } satisfies Prisma.LeadUncheckedCreateInput;
}

export async function createLeadInTx(tx: Tx, data: LeadData, actorId: string, action = "lead.created") {
  const lead = await tx.lead.create({
    data: {
      ...leadColumns(data),
      ownerId: data.ownerId ?? actorId,
      createdById: actorId,
      stageHistory: { create: { toStage: "NEW", changedById: actorId } },
    },
  });
  await logActivity(tx, { actorId, action, entityType: "Lead", entityId: lead.id });
  return lead;
}

export function createLead(db: Db, data: LeadData, actorId: string) {
  return db.$transaction((tx) => createLeadInTx(tx, data, actorId));
}

export async function updateLead(db: Db, id: string, data: LeadData, actorId: string) {
  return db.$transaction(async (tx) => {
    const before = await tx.lead.findUnique({ where: { id } });
    if (!before) throw new BusinessError("This lead no longer exists.");
    if (before.archivedAt) throw new BusinessError("This lead is archived. Restore it before making changes.");
    const after = await tx.lead.update({ where: { id }, data: leadColumns(data) });
    const changes = diffChanges(before, after, LEAD_FIELDS);
    if (Object.keys(changes).length) {
      await logActivity(tx, { actorId, action: "lead.updated", entityType: "Lead", entityId: id, clientId: before.convertedClientId, changes });
    }
    return after;
  });
}

export async function changeLeadStage(db: Db, input: { leadId: string; stage: LeadStage; lostReason: string | null; actorId: string }) {
  return db.$transaction(async (tx) => {
    const lead = await tx.lead.findUnique({ where: { id: input.leadId } });
    if (!lead) throw new BusinessError("This lead no longer exists.");
    if (lead.archivedAt) throw new BusinessError("This lead is archived. Restore it before making changes.");
    const problem = stageChangeError({
      from: lead.stage,
      to: input.stage,
      converted: !!lead.convertedClientId,
      lostReason: input.lostReason,
    });
    if (problem) throw new BusinessError(problem);

    const lost = input.stage === "LOST";
    await tx.lead.update({
      where: { id: lead.id },
      data: { stage: input.stage, lostReason: lost ? input.lostReason : null, ...(lost ? { nextFollowUpDate: null } : {}) },
    });
    await tx.leadStageHistory.create({
      data: { leadId: lead.id, fromStage: lead.stage, toStage: input.stage, note: lost ? input.lostReason : null, changedById: input.actorId },
    });
    await logActivity(tx, {
      actorId: input.actorId, action: "lead.stage_changed", entityType: "Lead", entityId: lead.id,
      changes: { stage: { from: lead.stage, to: input.stage } },
    });
  });
}

/**
 * Turns a lead into a client, or links it to a client that already exists.
 * The lead becomes Won, and its offers and notes move to the client. Everything
 * happens together or not at all, and a lead can only ever be converted once,
 * even if the button is clicked twice at the same moment.
 */
export async function convertLead(
  db: Db,
  input: { leadId: string; actorId: string } & ({ client: ClientCreateData } | { linkClientId: string }),
) {
  return db.$transaction((tx) => convertLeadInTx(tx, input));
}

/** The conversion itself. Runs inside the caller's transaction (manual convert, or an accepted offer). */
export async function convertLeadInTx(
  tx: Tx,
  input: { leadId: string; actorId: string | null; note?: string } & ({ client: ClientCreateData } | { linkClientId: string }),
) {
  const lead = await tx.lead.findUnique({ where: { id: input.leadId } });
  if (!lead) throw new BusinessError("This lead no longer exists.");
  if (lead.archivedAt) throw new BusinessError("This lead is archived. Restore it before converting.");
  if (lead.convertedClientId) throw new BusinessError("This lead has already been converted to a client.");

  let clientId: string;
  if ("client" in input) {
    clientId = (await createClientInTx(tx, input.client, input.actorId, "client.created_from_lead")).id;
  } else {
    const existing = await tx.client.findFirst({ where: { id: input.linkClientId, archivedAt: null } });
    if (!existing) throw new BusinessError("That client can't be linked. It may have been archived.");
    clientId = existing.id;
  }

  const { count } = await tx.lead.updateMany({
    where: { id: lead.id, convertedClientId: null },
    data: { convertedClientId: clientId, convertedAt: new Date(), stage: "WON", lostReason: null, nextFollowUpDate: null },
  });
  if (!count) throw new BusinessError("This lead has already been converted to a client.");

  await tx.offer.updateMany({ where: { leadId: lead.id, clientId: null }, data: { clientId } });
  await tx.communicationLog.updateMany({ where: { leadId: lead.id, clientId: null }, data: { clientId } });
  const accepted = await tx.offer.findMany({ where: { leadId: lead.id, status: "ACCEPTED" }, select: { id: true } });
  for (const offer of accepted) await ensureOfferOnboarding(tx, offer.id);
  if (lead.stage !== "WON") {
    await tx.leadStageHistory.create({
      data: { leadId: lead.id, fromStage: lead.stage, toStage: "WON", note: input.note ?? "Converted to client", changedById: input.actorId },
    });
  }
  await logActivity(tx, {
    actorId: input.actorId, action: "lead.converted", entityType: "Lead", entityId: lead.id, clientId,
    changes: { stage: { from: lead.stage, to: "WON" } },
  });
  return { clientId };
}

export type AutoConversion =
  | { result: "none" }
  | { result: "created" | "linked"; clientId: string; clientName: string }
  | { result: "needs_review"; reason: string };

/**
 * An offer to a lead was accepted, so the lead becomes a client straight away (decision A).
 * - No existing client shares its phone or email → a new client is made from the lead's details.
 * - Exactly one active client matches → the lead is linked to that client instead of making a duplicate.
 * - Several match, an archived client matches, or the lead's details aren't valid for a client →
 *   nothing is guessed: the lead stays as it is and you're told to convert it by hand.
 * The client's state is the one chosen on the offer, so GST stays exactly as quoted.
 */
export async function autoConvertLeadForOffer(tx: Tx, offerId: string, actorId: string | null): Promise<AutoConversion> {
  const offer = await tx.offer.findUnique({ where: { id: offerId }, include: { lead: true } });
  const lead = offer?.lead;
  if (!offer || offer.status !== "ACCEPTED" || !lead || lead.convertedClientId) return { result: "none" };
  if (lead.archivedAt) return { result: "needs_review", reason: "The lead is archived" };

  const note = `Offer ${offer.number} accepted, converted automatically`;
  const matches = findDuplicates({ phones: [lead.phone, lead.whatsapp], emails: [lead.email] }, await loadContactables(tx, { leads: false }));
  if (matches.length > 1) {
    return { result: "needs_review", reason: `It matches ${matches.length} existing clients (${matches.map((m) => m.name).join(", ")})` };
  }
  if (matches.length === 1) {
    const existing = await tx.client.findUnique({ where: { id: matches[0].id }, select: { id: true, companyName: true, archivedAt: true } });
    if (!existing || existing.archivedAt) return { result: "needs_review", reason: `It matches the archived client ${matches[0].name}` };
    await convertLeadInTx(tx, { leadId: lead.id, linkClientId: existing.id, actorId, note: `${note} (linked to an existing client by ${matches[0].reasons.join(" and ")})` });
    return { result: "linked", clientId: existing.id, clientName: existing.companyName };
  }

  const settings = await tx.settings.findUniqueOrThrow({ where: { id: "agency" } });
  const parsed = clientCreateSchema.safeParse({
    companyName: lead.companyName || lead.contactName,
    contactName: lead.contactName,
    contactDesignation: "",
    phone: lead.phone ?? "",
    whatsapp: lead.whatsapp ?? "",
    email: lead.email ?? "",
    website: "",
    sectorId: lead.sectorId ?? "",
    city: lead.city ?? "",
    country: "India",
    stateCode: offer.supplyStateCode || settings.stateCode,
    billingAddress: "",
    pincode: "",
    gstin: "",
    pan: "",
    leadSourceId: lead.leadSourceId ?? "",
    accountManagerId: lead.ownerId ?? actorId ?? "",
    tags: "",
    notes: lead.requirementNotes ?? "",
    status: "ACTIVE",
  });
  if (!parsed.success) return { result: "needs_review", reason: `The lead's details need fixing first (${parsed.error.issues[0].message})` };
  const { clientId } = await convertLeadInTx(tx, { leadId: lead.id, client: parsed.data, actorId, note });
  return { result: "created", clientId, clientName: parsed.data.companyName };
}

/**
 * An offer was rejected. If its lead has no other open offer (Draft, Sent or On Hold), the lead is
 * Lost with the same reason. Converted, Won and already-Lost leads are left alone.
 */
export async function markLeadLostForRejectedOffer(tx: Tx, offerId: string, reason: string, actorId: string | null): Promise<boolean> {
  const offer = await tx.offer.findUnique({ where: { id: offerId }, include: { lead: true } });
  const lead = offer?.lead;
  if (!offer || !lead || lead.convertedClientId || lead.archivedAt || lead.stage === "WON" || lead.stage === "LOST") return false;
  const open = await tx.offer.count({
    where: { leadId: lead.id, id: { not: offer.id }, isTemplate: false, archivedAt: null, status: { in: ["DRAFT", "SENT", "ON_HOLD"] } },
  });
  if (open) return false;
  const { count } = await tx.lead.updateMany({
    where: { id: lead.id, stage: lead.stage, convertedClientId: null },
    data: { stage: "LOST", lostReason: reason, nextFollowUpDate: null },
  });
  if (!count) return false;
  await tx.leadStageHistory.create({
    data: { leadId: lead.id, fromStage: lead.stage, toStage: "LOST", note: `Offer ${offer.number} rejected: ${reason}`, changedById: actorId },
  });
  await logActivity(tx, {
    actorId, action: "lead.stage_changed", entityType: "Lead", entityId: lead.id,
    changes: { stage: { from: lead.stage, to: "LOST" }, reason, offer: offer.number },
  });
  return true;
}

export async function setLeadArchived(db: Db, id: string, archived: boolean, actorId: string) {
  await db.$transaction(async (tx) => {
    const lead = await tx.lead.findUnique({ where: { id } });
    if (!lead) throw new BusinessError("This lead no longer exists.");
    if (!!lead.archivedAt === archived) return;
    await tx.lead.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await logActivity(tx, { actorId, action: archived ? "lead.archived" : "lead.restored", entityType: "Lead", entityId: id, clientId: lead.convertedClientId });
  });
}
