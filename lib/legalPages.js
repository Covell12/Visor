// Privacy policy and terms, served at /privacy and /terms.
// Kept in code (not public/) so they're always part of the deployed server.
// If you change what Visor collects, update the privacy page in the same change.

const UPDATED = 'October 10, 2026';
const contact = () => process.env.CONTACT_EMAIL
  ? `<a href="mailto:${process.env.CONTACT_EMAIL}">${process.env.CONTACT_EMAIL}</a>`
  : 'the support email shown on Visor’s Google sign-in screen';

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · Visor</title>
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/app.css">
<style>
  .legal { max-width: 760px; margin: 0 auto; padding: 40px 20px 60px; }
  .legal header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .legal header img { height: 34px; }
  .legal h1 { font-size: 28px; margin: 0 0 4px; }
  .legal h2 { font-size: 17px; margin: 26px 0 8px; }
  .legal p, .legal li { font-size: 15px; line-height: 1.65; }
  .legal ul { padding-left: 20px; }
</style>
</head><body>
<main class="legal">
  <header><a href="/"><img src="/logo.png" alt="Visor"></a></header>
  <div class="card card-pad">${body}</div>
  <p class="small muted" style="margin-top:16px;"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/">Back to Visor</a></p>
</main>
</body></html>`;
}

function privacy() {
  return page('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="muted small">Last updated ${UPDATED}</p>

<p>Visor helps teachers see how a student group project was done, using meeting recordings and the edit history of the group's Google Docs or Slides. This page says exactly what Visor stores, why, and who else handles it.</p>

<h2>What Visor stores</h2>
<ul>
  <li><b>Your account:</b> first and last name, email address, whether you are a student or teacher, the school you chose (if any; picking one is optional), an optional icon color, and either a salted hash of your password (never the password itself) or, if you used <i>Sign in with Google</i>, no password at all.</li>
  <li><b>Projects:</b> each project's name, its teacher and students, and its project code.</li>
  <li><b>Recordings</b> that a project member uploads or records, their transcripts, and the names members assign to each voice.</li>
  <li><b>Document reports:</b> for a Google Doc or Slides file added to a project, the file's title and link and, for each person who edited it, their name and email as shown in the file's history and counted figures: characters added and deleted, edit counts, typing and pasting measurements, writing sessions and edits per hour, and for each paste or deletion who made it, when, and how many characters (and whether a paste came from inside or outside the document). Visor does not store the text of the document, or the text that was pasted or deleted.</li>
  <li><b>Analysis reports</b> a teacher runs for a project.</li>
</ul>

<h2>Where document data comes from</h2>
<ul>
  <li><b>The Visor Chrome extension.</b> When someone clicks <i>Send to Website</i> and enters a project code, the extension sends the counted figures above to that project. It does not send the document's text, pasted text, or deleted text.</li>
  <li><b>Google Drive.</b> If you choose <i>Connect Google Drive</i>, Google asks you to allow Visor the <code>drive.file</code> permission, and you pick one file in Google's own file picker. Visor can only access files you pick this way, never the rest of your Drive. Visor then reads that file's saved revisions, compares their text to count who added and removed how much, and stores only the counts. The text is discarded as soon as the comparison is done. The Google access token is used for that one request and is not stored.</li>
</ul>

<h2>Google user data</h2>
<p>Visor's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements. Google Drive data is used only to show revision history inside the project you added it to. It is never sold, never used for advertising, and never used to train AI models.</p>

<h2>Who else handles the data</h2>
<ul>
  <li><b>Google Firebase</b> (Google Cloud) hosts the website and runs Visor's server. Accounts, projects and reports are kept in Cloud Firestore, and recordings in private Cloud Storage, in the United States.</li>
  <li><b>Google's Gemini models, through Vertex AI in Google Cloud,</b> transcribe recordings and write the analysis report. Recordings, transcripts, and the counted figures in document reports are sent to it for that purpose only. Under Google Cloud's terms, this data is not used to train Google's models.</li>
</ul>
<p>Visor does not sell data and does not use advertising or analytics trackers.</p>

<h2>Who can see what</h2>
<p>A project's recordings, transcripts, and document reports are visible to its teacher and students. The analysis report is visible to the teacher, and to students only if the teacher turns that on. Recordings can only be played by signed-in project members.</p>

<h2>Signing in with Google</h2>
<p>If you use <i>Sign in with Google</i>, Google confirms your identity and shares your name and email address with Visor so we can create or find your account. Visor does not receive or ask for your Google password, and this is separate from the <code>drive.file</code> access described above — signing in this way does not give Visor access to your Drive.</p>

<h2>Cookies</h2>
<p>Visor sets one cookie to keep you signed in. It contains no tracking information.</p>

<h2>Keeping and deleting data</h2>
<p>Data stays until it is deleted. The person who added a resource, or the project's teacher, can delete it at any time; deleting a recording deletes the audio file. Deleting a project deletes all of its recordings, reports, and analysis. To delete your account, contact ${contact()}.</p>

<h2>Students and recordings</h2>
<p>Visor is meant to be used by schools. Teachers are responsible for any consent their school requires, and everyone who is recorded should know they are being recorded.</p>

<h2>Changes and contact</h2>
<p>If this policy changes, the date at the top changes too. Questions: ${contact()}.</p>
`);
}

function terms() {
  return page('Terms of Service', `
<h1>Terms of Service</h1>
<p class="muted small">Last updated ${UPDATED}</p>
<p>Visor is provided free of charge and as-is, without any guarantee of availability or accuracy.</p>
<ul>
  <li>Only add documents you have permission to access, and only upload recordings when the people in them have agreed to be recorded.</li>
  <li>Revision counts, transcripts, and AI-written reports can be wrong or incomplete. Google Drive keeps periodic snapshots rather than every edit, so Drive-based reports are approximate. Treat every report as evidence to discuss, never as a final judgment of a person.</li>
  <li>Don't use Visor to harass, surveil, or discriminate against anyone.</li>
  <li>Visor may change or stop at any time. Download or copy anything you need to keep.</li>
</ul>
<p>See the <a href="/privacy">Privacy Policy</a> for what Visor stores.</p>
`);
}

module.exports = { privacy, terms };
