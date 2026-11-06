import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * The connected journey, one test that grows with each batch of the flow work.
 * Batch A: login → create lead → create offer (pre-filled from the lead) → send →
 * client accepts via the public link → the lead is Won and a client exists.
 * Later batches extend it: convert to project → tasks → invoice → payment → dashboard.
 */
const LEAD_PAGE = /\/leads\/(?!new$)[a-z0-9]+$/;
const OFFER_PAGE = /\/offers\/(?!new$|templates)[a-z0-9]+$/;

test("connected flow: lead → offer → accepted → client", async ({ page, browser }) => {
  const seed = `${Date.now()}`.slice(-9);
  const company = `Flow Co ${seed}`;
  await login(page);

  // 1. A lead with two services in mind
  await page.goto("/leads/new");
  await page.getByLabel("Contact person").fill(`Flow Person ${seed}`);
  await page.getByLabel("Company").fill(company);
  await page.getByLabel("Phone").fill(`9${seed}`);
  await page.getByRole("button", { name: "Meta Ads" }).click();
  await page.getByRole("button", { name: "Social Media Marketing" }).click();
  await page.getByRole("button", { name: "Create lead" }).click();
  await expect(page).toHaveURL(LEAD_PAGE);
  const leadUrl = page.url();

  // 2. New offer from the lead: recipient, title and lines are already filled in
  await page.getByRole("link", { name: "New offer" }).click();
  await expect(page).toHaveURL(/\/offers\/new\?lead=/);
  await expect(page.getByLabel("Offer title")).toHaveValue(`Proposal for ${company}`);
  await expect(page.getByRole("combobox", { name: "Item 1 service", exact: true })).toHaveText("Meta Ads");
  await expect(page.getByRole("combobox", { name: "Item 2 service", exact: true })).toHaveText("Social Media Marketing");
  await expect(page.getByLabel("Item 1 rate")).toHaveValue(/^\d/);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(OFFER_PAGE);
  const offerUrl = page.url();

  // 3. Send it and take the client link
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Share myself (WhatsApp)" }).click();
  const linkBox = page.getByTestId("client-link");
  await expect(linkBox).toHaveValue(/\/p\/offer\/[\w-]{43}$/);
  const link = new URL(await linkBox.inputValue()).pathname;
  await page.keyboard.press("Escape");

  await page.goto(leadUrl);
  await expect(page.getByText("Offer Sent").first()).toBeVisible();

  // 4. The client accepts in a separate browser with no login
  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  await client.goto(link);
  await client.getByRole("button", { name: "Accept this offer" }).click();
  await client.getByLabel("Your name").fill(`Flow Person ${seed}`);
  await client.getByRole("checkbox").check();
  await client.getByRole("button", { name: "Confirm acceptance" }).click();
  await expect(client.getByText(new RegExp(`Accepted by Flow Person ${seed}`))).toBeVisible();
  await clientContext.close();

  // 5. Back at the agency: the lead became a client by itself
  await page.goto(leadUrl);
  const converted = page.getByRole("status").filter({ hasText: "Converted to client" });
  await expect(converted).toBeVisible();
  await expect(page.getByRole("link", { name: "Convert to client" })).toHaveCount(0);
  await converted.getByRole("link", { name: company }).click();
  await expect(page).toHaveURL(/\/clients\/[a-z0-9]+/);
  await expect(page.getByRole("heading", { name: company })).toBeVisible();

  // The accepted offer now belongs to that client and can become a project (next batch)
  await page.goto(offerUrl);
  await expect(page.getByRole("link", { name: company }).first()).toBeVisible();
});
