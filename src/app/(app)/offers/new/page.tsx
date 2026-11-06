import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/page-header";
import { requirePermission } from "@/lib/auth-guard";
import { db } from "@/lib/db";
import { idParam, type SearchParams } from "@/lib/list-params";
import { getOfferFormOptions, getTemplates } from "@/server/queries/offers";
import { newOfferValues } from "../form-values";
import { OfferForm } from "../offer-form";
import { TemplatePicker } from "./template-picker";

export const metadata: Metadata = { title: "New offer" };

export default async function NewOfferPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("sales.manage");
  const sp = await searchParams;
  const templateId = idParam(sp, "template");
  const leadId = idParam(sp, "lead");
  const [options, templates, template, lead] = await Promise.all([
    getOfferFormOptions(),
    getTemplates(),
    templateId
      ? db.offer.findFirst({
          where: { id: templateId, isTemplate: true, archivedAt: null },
          include: { items: { orderBy: { sortOrder: "asc" } }, milestones: { orderBy: { sortOrder: "asc" } } },
        })
      : null,
    leadId
      ? db.lead.findFirst({
          where: { id: leadId, archivedAt: null },
          select: { id: true, contactName: true, companyName: true, servicesInterested: true, convertedClientId: true },
        })
      : null,
  ]);
  // A converted lead is a client now, so the offer goes to the client (the server does the same).
  const clientId = lead?.convertedClientId ?? idParam(sp, "client");
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="New offer" back={{ href: "/offers", label: "Offers" }} />
      {templates.length > 0 && (
        <TemplatePicker selected={templateId ?? ""} templates={templates.map((t) => ({ value: t.id, label: t.templateName ?? t.title }))} />
      )}
      <OfferForm
        key={templateId ?? "blank"}
        mode={{ kind: "offer", offerId: null }}
        options={options}
        defaults={newOfferValues(options, {
          clientId,
          leadId: lead && !lead.convertedClientId ? lead.id : undefined,
          template,
          lead: lead ? { name: lead.companyName || lead.contactName, serviceIds: lead.servicesInterested } : null,
        })}
      />
    </div>
  );
}
