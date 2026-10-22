/**
 * Configure the gateway's merchant record for a deployment.
 *
 * On a cold deployment the gateway seeds a demo merchant whose webhook URL
 * points at the demo store (http://localhost:5000/api/webhook) and whose
 * branding is empty. Both must be corrected before a real payment can settle,
 * so this script writes them from the environment.
 *
 * It is idempotent: run it on every deploy and it converges on the same state.
 *
 * ENVIRONMENT
 *   MERCHANT_NAME         display name, e.g. "VASTTU DEVO"
 *   MERCHANT_EMAIL        contact email shown on the checkout page
 *   MERCHANT_PHONE        contact phone shown on the checkout page
 *   MERCHANT_WEBHOOK_URL  absolute HTTPS URL that receives the signed webhook
 *                         (e.g. https://vasttudevo.com/api/payments/webhook/youpi)
 *   MERCHANT_CUSTOM_DOMAIN public checkout origin, e.g. https://pay.vasttudevo.com
 *   MERCHANT_PRIMARY_COLOR brand colour, e.g. #4f46e5
 *   MERCHANT_ENV_MODE     "production" or "localhost"
 *   MERCHANT_UPI_ID       receiving UPI id (VPA), e.g. pavangandhi@icici
 *   MERCHANT_PAYEE_NAME   payee name shown on the customer's UPI app
 *   MERCHANT_SLUG         store slug
 *
 * Usage:  node scripts/configure-merchant.mjs [--dry-run]
 */

import { getDatabase, ensureDatabaseInitialized, MerchantRepository, ReceivingAccountRepository } from "@youpi/db";
import { runMigrations } from "@youpi/db";
import { getCoinStoreWebhookSecret } from "@youpi/common";

const DRY_RUN = process.argv.includes("--dry-run");

const env = (name, fallback = "") => (process.env[name] || fallback).trim();

const db = getDatabase();
ensureDatabaseInitialized(db);
const { defaultMerchant } = runMigrations(db);
if (!defaultMerchant) {
  console.error("No default merchant found — has the database been seeded?");
  process.exit(1);
}

const merchantRepo = new MerchantRepository(db);
const accountRepo = new ReceivingAccountRepository(db);

const current = merchantRepo.findById(defaultMerchant.id);
const branding = { ...(current?.branding || {}) };

const webhookUrl = env("MERCHANT_WEBHOOK_URL");
const customDomain = env("MERCHANT_CUSTOM_DOMAIN");

const nextBranding = {
  ...branding,
  appName: env("MERCHANT_APP_NAME", "VASTTUDEVO") || branding.appName,
  primaryColor: env("MERCHANT_PRIMARY_COLOR", branding.primaryColor || "#4f46e5"),
  // A broken logo URL makes the checkout header render an empty image. Leaving
  // this null lets the portal fall back to the letter avatar.
  logoUrl: branding.logoUrl ?? null,
  envMode: env("MERCHANT_ENV_MODE", "production"),
  customDomain: customDomain || branding.customDomain,
  deploymentPrefix: env("MERCHANT_DEPLOYMENT_PREFIX", branding.deploymentPrefix || "pay"),
  cloudflareDomain: env("MERCHANT_CLOUDFLARE_DOMAIN", branding.cloudflareDomain || ""),
  sellingMode: "ONLINE",
};

const updates = {
  businessName: env("MERCHANT_NAME", current?.businessName) || current?.businessName,
  contactEmail: env("MERCHANT_EMAIL", current?.contactEmail) || current?.contactEmail,
  contactPhone: env("MERCHANT_PHONE", current?.contactPhone) || current?.contactPhone,
  webhookUrl: webhookUrl || current?.webhookUrl,
  branding: nextBranding,
};

const upiId = env("MERCHANT_UPI_ID");
const payeeName = env("MERCHANT_PAYEE_NAME");
const accounts = accountRepo.findByMerchantId(defaultMerchant.id);
let accountUpdate = null;

if (upiId && accounts.length === 0) {
  accountUpdate = { create: true, upiId, payeeName: payeeName || updates.businessName };
} else if (upiId && accounts.length > 0 && accounts[0].upiId !== upiId) {
  accountUpdate = { create: false, id: accounts[0].id, upiId, payeeName: payeeName || accounts[0].payeeName };
}

console.log("Merchant configuration");
console.log("-----------------------");
console.log(`  id             : ${defaultMerchant.id}`);
console.log(`  business name  : ${updates.businessName}`);
console.log(`  webhook url    : ${updates.webhookUrl}`);
console.log(`  webhook secret : ${getCoinStoreWebhookSecret().slice(0, 8)}… (unchanged, still verified with HMAC-SHA256)`);
console.log(`  checkout origin: ${nextBranding.customDomain}`);
console.log(`  env mode       : ${nextBranding.envMode}`);
console.log(`  primary colour : ${nextBranding.primaryColor}`);
console.log(`  logo url       : ${nextBranding.logoUrl ?? "(none — letter avatar fallback)"}`);
console.log(`  receiving UPI  : ${accountUpdate ? accountUpdate.upiId : accounts[0]?.upiId || "(none)"}`);
console.log(`  payee name     : ${accountUpdate ? accountUpdate.payeeName : accounts[0]?.payeeName || "(none)"}`);

if (DRY_RUN) {
  console.log("\n--dry-run: nothing was written.");
  process.exit(0);
}

merchantRepo.update(defaultMerchant.id, updates);
console.log("\nMerchant record updated.");

if (accountUpdate?.create) {
  accountRepo.create({
    merchantId: defaultMerchant.id,
    upiId: accountUpdate.upiId,
    payeeName: accountUpdate.payeeName,
  });
  console.log("Receiving UPI account created.");
} else if (accountUpdate) {
  accountRepo.updateAccount(accountUpdate.id, {
    upiId: accountUpdate.upiId,
    payeeName: accountUpdate.payeeName,
  });
  console.log("Receiving UPI account updated.");
}

console.log("Done.");
