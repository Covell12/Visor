// Firebase Admin SDK, started on first use. Inside Cloud Functions it picks up
// the project, credentials and default Storage bucket automatically, and the
// emulators are found through the *_EMULATOR_HOST variables they set.

let app = null;
function adminApp() {
  if (!app) {
    const { initializeApp, getApps } = require('firebase-admin/app');
    app = getApps()[0] || initializeApp();
  }
  return app;
}

let db = null;
function firestore() {
  if (!db) {
    const { getFirestore } = require('firebase-admin/firestore');
    db = getFirestore(adminApp());
    db.settings({ ignoreUndefinedProperties: true });
  }
  return db;
}

function bucket() {
  const { getStorage } = require('firebase-admin/storage');
  return getStorage(adminApp()).bucket();
}

module.exports = { firestore, bucket };
