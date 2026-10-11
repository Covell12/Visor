// Where this copy of Visor is running.
//
//   firebase — deployed with `firebase deploy` (or the Firebase emulators).
//              index.js sets VISOR_PLATFORM=firebase before loading the app.
//              Data: Firestore. Recordings: Cloud Storage.
//   local    — `npm start` on your own computer.
//              Data: embedded Postgres in data/pglite (or DATABASE_URL if set).
//              Recordings: data/audio.

const IS_FIREBASE = process.env.VISOR_PLATFORM === 'firebase';
const IS_EMULATOR = !!process.env.FUNCTIONS_EMULATOR;
const IS_PROD = (IS_FIREBASE && !IS_EMULATOR) || process.env.NODE_ENV === 'production';

module.exports = { IS_FIREBASE, IS_EMULATOR, IS_PROD };
