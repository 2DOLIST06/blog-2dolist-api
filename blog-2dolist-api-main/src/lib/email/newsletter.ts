import { env } from '../../config/env.js';
import { buildLocalizedPath } from '../seo/urls.js';

type WelcomeEmail = { email: string; language: string; preferencesToken: string };

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function buildNewsletterLinks(language: string, preferencesToken: string) {
  const frontendUrl = (env.FRONTEND_URL ?? env.APP_URL).replace(/\/+$/g, '');
  const path = buildLocalizedPath(language, '/newsletter/preferences');
  const preferencesUrl = `${frontendUrl}${path}?token=${encodeURIComponent(preferencesToken)}`;
  return { preferencesUrl, unsubscribeUrl: `${preferencesUrl}&action=unsubscribe` };
}

export async function sendNewsletterWelcomeEmail(input: WelcomeEmail) {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL || !env.BREVO_SENDER_NAME) {
    throw new Error('Brevo is not configured.');
  }

  const { preferencesUrl, unsubscribeUrl } = buildNewsletterLinks(input.language, input.preferencesToken);
  const text = [
    'Bonjour,', '',
    'Votre inscription aux actualités du blog 2Dolist a bien été prise en compte.', '',
    'Vous pouvez choisir les activités aériennes, les destinations et les types de contenus que vous souhaitez recevoir.', '',
    `Gérer mes préférences : ${preferencesUrl}`,
    `Se désabonner : ${unsubscribeUrl}`
  ].join('\n');
  const html = `<p>Bonjour,</p><p>Votre inscription aux actualités du blog 2Dolist a bien été prise en compte.</p><p>Vous pouvez choisir les activités aériennes, les destinations et les types de contenus que vous souhaitez recevoir.</p><p><a href="${escapeHtml(preferencesUrl)}" style="display:inline-block;padding:12px 18px;background:#1769aa;color:#fff;text-decoration:none;border-radius:4px">Gérer mes préférences</a></p><p><a href="${escapeHtml(unsubscribeUrl)}">Se désabonner</a></p>`;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
      to: [{ email: input.email }],
      subject: 'Bienvenue sur 2Dolist', textContent: text, htmlContent: html
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Brevo request failed with status ${response.status}.`);
}
