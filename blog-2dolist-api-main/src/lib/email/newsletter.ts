import { env } from '../../config/env.js';
import { sendEmail, textToHtml } from './smtp.js';

type NewsletterSubscriptionEmail = {
  email: string;
  source?: string;
};

export async function sendNewsletterSubscriptionEmail(subscription: NewsletterSubscriptionEmail) {
  const source = subscription.source?.trim() || 'Site The Muscle Temple';
  const subject = 'Nouvelle inscription newsletter - The Muscle Temple';
  const text = [
    'Bonjour,',
    '',
    'Une nouvelle inscription à la newsletter The Muscle Temple a été reçue.',
    '',
    `Email : ${subscription.email}`,
    `Source : ${source}`,
    `Date : ${new Date().toISOString()}`,
    '',
    'Cet e-mail a été envoyé automatiquement par l’API The Muscle Temple.'
  ].join('\n');

  await sendEmail({
    from: env.MAIL_FROM as string,
    to: env.NEWSLETTER_RECIPIENT_EMAIL,
    replyTo: subscription.email,
    subject,
    text,
    html: textToHtml(text)
  });
}
