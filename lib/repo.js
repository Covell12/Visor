// Picks the data store: Firestore on Firebase, Postgres (embedded or
// DATABASE_URL) everywhere else. Both expose the same functions.
const { IS_FIREBASE } = require('./platform');
module.exports = IS_FIREBASE ? require('./repoFirestore') : require('./repoSql');
