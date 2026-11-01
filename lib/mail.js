// Sending email (password resets). Any SMTP account works; Visor's is a Gmail
// address with an app password. Settings come from the environment:
//
//   MAIL_PASSWORD  the password (a Google Cloud secret on Firebase; see README.md)
//   MAIL_USER      the account (default visor.edu.ai@gmail.com)
//   MAIL_HOST      default smtp.gmail.com, MAIL_PORT default 587
//   MAIL_FROM      who it says it's from (default "Visor" <MAIL_USER>)
//
// Without a password nothing is sent and ready() says so, and the sign-in page
// offers the contact address instead. MAIL_TRANSPORT=memory keeps messages in
// `sent` and is for tests and local runs: nothing leaves the machine.

const nodemailer = require('nodemailer');

const sent = [];
const memory = () => process.env.MAIL_TRANSPORT === 'memory';
const ready = () => memory() || !!process.env.MAIL_PASSWORD;
const user = () => process.env.MAIL_USER || 'visor.edu.ai@gmail.com';

let transport = null;
function transporter() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.gmail.com', port: Number(process.env.MAIL_PORT) || 587,
      auth: { user: user(), pass: process.env.MAIL_PASSWORD },
      // A slow mail server must not hold up the page
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000
    });
  }
  return transport;
}

async function send({ to, subject, text, html }) {
  if (memory()) {
    sent.push({ to, subject, text, html });
    if (process.env.NODE_ENV !== 'test') console.log(`mail, not sent, to ${to}: ${subject}\n${text}`);
    return;
  }
  if (!ready()) throw new Error('email isn’t set up');
  await transporter().sendMail({ from: process.env.MAIL_FROM || `"Visor" <${user()}>`, to, subject, text, html });
}

module.exports = { ready, send, sent };
