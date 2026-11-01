// Privacy policy and terms, served at /privacy and /terms.
// Kept in code (not public/) so they're always part of the deployed server.
// If you change what Visor collects, update the privacy page in the same change.

const UPDATED = 'November 1, 2026';
const contact = () => {
  const email = process.env.CONTACT_EMAIL || 'visor.edu.ai@gmail.com';
  return `<a href="mailto:${email}">${email}</a>`;
};

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} · Visor</title>
<link rel="icon" href="/favicon.png?v=2"><link rel="stylesheet" href="/app.css">
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

<p>Visor Classroom is where students write essays, research, and discuss, and where teachers see how that work was done: writing sessions in Visor's own editor, group projects (meeting recordings and the edit history of the group's Google Docs or Slides), and recorded class discussions. This page says exactly what Visor stores, why, who can see it, how long it's kept, and who else handles it.</p>

<h2>Writing sessions, in plain words</h2>
<ul>
  <li><b>What's recorded:</b> while a student writes in Visor's editor during a writing session, every edit is kept in order (what was typed, deleted, formatted or pasted, and when), so the teacher can replay how the essay was written. For each paste Visor keeps where it came from: within the essay, a page the student copied during a session, or outside Visor's view. Each session also records when it started and ended, and every time the student left the Visor tab or window, went offline, or left full screen, with how long they were away. Students see the same pause information the teacher sees. On assignments that block AI sites, the editor also asks grammar and AI writing tools from other browser extensions to stay out of the essay, and records the name of any known one that appears on the essay page anyway (Grammarly, for example), never what it shows.</li>
  <li><b>Pictures in essays:</b> a picture a student adds to an essay from their computer is uploaded to Visor and kept with the essay, along with its type, file size and dimensions. Pictures taken out of the essay later are kept too, so the replay can still show them.</li>
  <li><b>What isn't:</b> Visor doesn't record the student's screen, camera or microphone during a writing session, and doesn't read other apps.</li>
  <li><b>Notes for the teacher</b> are factual sentences written by fixed rules from these measurements (for example, "Left the writing tab 7 times, 11 min in total"). Visor never labels writing as AI-generated and never gives a probability that it is.</li>
</ul>

<h2>The Visor Chrome extension, in plain words</h2>
<ul>
  <li><b>On Google Docs and Slides,</b> for a file you can edit, the extension reads its revision history and works out who wrote what in your browser. That history, including the document's text and its editors' names and email addresses, stays in the tab and is discarded when you close it. AWARE mode colors the document on your screen only and changes nothing in it. Your display settings stay in your browser. No account is needed, and only what's described under <i>Where document data comes from</i> is ever sent to Visor.</li>
  <li><b>Only during a writing session,</b> and only when the student's assignment records research, the extension records: the searches the student makes and on which search engine, the pages they visit (address and title) and how long each was open, text they copy from a page (its length, a fingerprint used to match it to a later paste, and its first 140 characters), visits to AI and answer sites, sites the session blocked, and citations they add. The toolbar icon shows <b>REC</b> the whole time. Outside a session it records none of this.</li>
  <li>It never records what a student types on other sites, passwords, or the content of pages, beyond the text they copy and the title and author details of a page they choose to cite.</li>
  <li>In a <b>locked</b> session (an in-class essay) it keeps the student on the sites the teacher allowed. If the student writes in the side panel, other sites (not AI sites) open while the panel is on screen; closing the panel brings the allowed list back and records that it was closed.</li>
  <li>Students connect the extension to their Visor account on <i>/extension/connect</i>, which keeps a token in their browser for up to 30 days; they can disconnect it from their Profile at any time.</li>
</ul>

<h2>Class discussions</h2>
<p>A teacher can record a class discussion after confirming that students have been told and the school allows it. Visor transcribes it, the teacher matches voices to students, and Visor measures each student's talk time, turns and words from the transcript's timestamps. An AI-written summary (clearly labelled, with quotes linked to the transcript) can be added. The teacher decides whether students see their own numbers; students never see anyone else's.</p>

<h2>What Visor stores</h2>
<ul>
  <li><b>Your account:</b> first and last name, email address, whether you are a student or teacher, the school you chose (if any; picking one is optional), an optional icon color or profile picture, and either a salted hash of your password (never the password itself) or, if you used <i>Sign in with Google</i>, no password at all.</li>
  <li><b>Projects:</b> each project's name, its teacher and students, and its project code.</li>
  <li><b>Recordings</b> that a project member uploads or records, their transcripts, and the names members assign to each voice.</li>
  <li><b>Document reports:</b> for a Google Doc or Slides file added to a project, the file's title and link and, for each person who edited it, their name and email as shown in the file's history and counted figures: characters added and deleted, edit counts, typing and pasting measurements, writing sessions and edits per hour, and for each paste or deletion who made it, when, and how many characters (and whether a paste came from inside or outside the document). Visor does not store the text of the document, or the text that was pasted or deleted.</li>
  <li><b>Analysis reports</b> a teacher runs for a project.</li>
  <li><b>Classes:</b> each class's name, its teachers, assistant teachers and advisors, its students, join code, invited email addresses (until those students sign up), and any extra time a teacher sets for a student.</li>
  <li><b>Classroom work:</b> assignments; each student's essays with their full edit history and the pictures they added, writing sessions, citations, feedback and scores; research recorded by the extension during sessions; class discussion recordings, transcripts and results.</li>
</ul>

<h2>Where document data comes from</h2>
<ul>
  <li><b>The Visor Chrome extension.</b> When someone uses <i>Send to Visor</i> on the extension's Overview tab (with a project code, or picking one of their projects once the extension is connected), the extension sends the counted figures above to that project. When a connected student opens a Google Doc that their teacher linked to their group project, the extension sends those figures to the project automatically, at most every five minutes. It never sends the document's text, pasted text, or deleted text.</li>
  <li><b>Google Drive.</b> If you choose <i>Connect Google Drive</i>, Google asks you to allow Visor the <code>drive.file</code> permission, and you pick one file in Google's own file picker. Visor can only access files you pick this way, never the rest of your Drive. Visor then reads that file's saved revisions, compares their text to count who added and removed how much, and stores only the counts. The text is discarded as soon as the comparison is done. The Google access token is used for that one request and is not stored.</li>
</ul>

<h2>Google user data</h2>
<p>Visor's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements. Google Drive data is used only to show revision history inside the project you added it to. It is never sold, never used for advertising, and never used to train AI models.</p>

<h2>Who else handles the data</h2>
<ul>
  <li><b>Gmail</b> delivers the email Visor sends, such as a password reset link, so Google handles your email address and that message.</li>
  <li><b>Google Firebase</b> (Google Cloud) hosts the website and runs Visor's server. Accounts, projects and reports are kept in Cloud Firestore, and recordings, pictures added to essays and profile pictures in private Cloud Storage, in the United States.</li>
  <li><b>Google's Gemini models, through Vertex AI in Google Cloud,</b> transcribe recordings (group meetings and class discussions) and write the group-project report and the discussion summary. Recordings, transcripts, and the counted figures in document reports are sent to it for that purpose only. Essays (including their pictures) and research logs are not sent to Gemini. Under Google Cloud's terms, this data is not used to train Google's models.</li>
</ul>
<p>Visor does not sell data and does not use advertising or analytics trackers.</p>

<h2>Who can see what</h2>
<p>A project's recordings, transcripts, and document reports are visible to its teacher and students. The analysis report is visible to the teacher, and to students only if the teacher turns that on. Recordings can only be played by signed-in project members.</p>
<p><b>Schools on Visor.</b> A teacher can create a school and become its facilitator. A facilitator adds the email addresses of the people who can join, each with a name, role and grades, and can send them invitations; those details are kept until they are removed. Teachers in a school can see its students and teachers, with their names, email addresses, roles and grades, and whether they have joined. Students don't see this list. A school's logo can be seen by anyone with a link to it, because invitations show it.</p>
<p>A profile picture is optional. It is shown beside your name to signed-in people who see your name in Visor: your classes and projects, and teachers at the school you chose. You can remove it any time in Profile settings, which deletes it. Visor's page crops it to a square and redraws it before uploading, which leaves out details stored in a photo file, such as where it was taken.</p>
<p>A student's essay, its edit history and pictures, their writing sessions and the research recorded during them are visible to that student and the class's teachers, and to no other student. Pictures are only shown through Visor, to those two people; the picture links Visor's pages use stop working after 12 hours. Class discussion recordings and results are visible to the class's teachers; a student sees only their own numbers, and only if the teacher shares them.</p>

<p>A class can have more than one teacher: its owner, co-teachers, assistant teachers and advisors. Each of them can see everything in the class, including its group projects. <b>Advisors aren't listed as teachers,</b> so students may not see their names on the class's pages, though anything an advisor posts or comments shows their name.</p>

<h2>Signing in with Google</h2>
<p>If you use <i>Sign in with Google</i>, Google confirms your identity and shares your name and email address with Visor so we can create or find your account. Visor does not receive or ask for your Google password, and this is separate from the <code>drive.file</code> access described above — signing in this way does not give Visor access to your Drive.</p>

<h2>Forgotten passwords</h2>
<p>If you ask for a password reset, Visor emails a link to the address on your account. The link works once, for one hour, and Visor keeps only a scrambled copy of it. Setting a new password signs you out everywhere else and disconnects the Chrome extension.</p>

<h2>Cookies</h2>
<p>Visor sets one cookie to keep you signed in. It contains no tracking information.</p>

<h2>Keeping and deleting data</h2>
<p>Data stays until it is deleted, with one exception: <b>research recorded by the extension is deleted automatically</b> after the class's retention period (180 days unless the teacher sets a different one). The person who added a resource, or the project's teacher, can delete it at any time; deleting a recording deletes the audio file. Deleting a project deletes all of its recordings, reports, and analysis. A teacher can delete one student's work in a class, an assignment, or a whole class with everything in it; deleting an essay this way also deletes the pictures in it. Students can download everything Visor keeps about them, as a file, from <i>Profile settings → Download my data</i>. The file lists each picture in their essays with a link that downloads it while they're signed in. To delete your account, contact ${contact()}.</p>

<h2>Students and recordings</h2>
<p>Visor is meant to be used by schools. Students confirm at sign-up that they are 13 or older, or that their school signed them up (a teacher added their email to a class). Teachers are responsible for any consent their school requires, and everyone who is recorded should know they are being recorded; Visor asks teachers to confirm this before a class's first discussion recording.</p>

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
