// Firebase entry point. `firebase deploy` reads this file and creates two
// Cloud Functions:
//
//   api        — the whole Express app (server.js). Firebase Hosting sends
//                /api/**, /privacy and /terms here; everything else is served
//                straight from public/.
//   transcribe — runs when the api writes a job to visor_jobs: downloads the
//                recording, has Gemini transcribe it, saves the result. One
//                recording per instance at a time (each needs ~200 MB of memory).
//
// On your computer, `npm start` runs server.js directly and this file isn't used.

process.env.VISOR_PLATFORM = 'firebase';

const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');

// Only used if GEMINI_VIA=apikey is set in .env. By default the server reaches
// Gemini through Vertex AI and needs no key (server.js, SECTION 1).
// Stored in Google Secret Manager: firebase functions:secrets:set GEMINI_API_KEY
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// us-central1 matches the "nam5 (United States)" Firestore location and the
// free tier of Cloud Storage. maxInstances caps how far traffic can scale (and cost).
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const app = require('./server');

exports.api = onRequest(
  { secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 300, concurrency: 20, invoker: 'public' },
  app
);

exports.transcribe = onDocumentCreated(
  { document: 'visor_jobs/{jobId}', secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 540, concurrency: 1, retry: false },
  async event => {
    const job = event.data?.data();
    try {
      if (job?.kind === 'transcribe' && job.resourceId) await app.runTranscriptionJob(job.resourceId);
    } finally {
      await event.data?.ref.delete().catch(() => {});
    }
  }
);

// ── Spending cut-off ────────────────────────────────────────────────────
// A Google Cloud budget can post its running total to a Pub/Sub topic. When
// the total passes the budget amount, this takes the billing account off the
// project. That stops every charge, and it also stops the site: the server,
// database and storage all go offline until billing is linked again by hand
// (Google Cloud Console → Billing → Account management). Setup: README.md.
//
// Google's cost figures arrive hours late, so the final bill can end up a
// little over the budget amount. Keep the budget below what you can accept.
const { onMessagePublished } = require('firebase-functions/v2/pubsub');

exports.stopBilling = onMessagePublished(
  { topic: 'visor-budget', memory: '256MiB', timeoutSeconds: 60, maxInstances: 1, retry: false },
  async event => {
    let data = null;
    try { data = event.data.message.json; } catch {}
    const cost = Number(data?.costAmount), budget = Number(data?.budgetAmount);
    if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) { console.warn('stopBilling: unreadable budget message', data); return; }
    if (cost <= budget) { console.log(`stopBilling: $${cost} of $${budget} used; nothing to do`); return; }

    const { GoogleAuth } = require('google-auth-library');
    const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    const url = `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`;
    const { data: info } = await client.request({ url });
    if (!info.billingEnabled) { console.log('stopBilling: billing is already off'); return; }
    await client.request({ url, method: 'PUT', data: { billingAccountName: '' } });
    console.error(`stopBilling: spending $${cost} passed the $${budget} budget. Billing was removed from ${project}; the site is offline until billing is linked again.`);
  }
);
