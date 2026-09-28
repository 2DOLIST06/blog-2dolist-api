import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters';
process.env.APP_URL ??= 'https://2dolist.example';
process.env.FRONTEND_URL ??= 'https://2dolist.example/';
process.env.BREVO_API_KEY ??= 'test-api-key';
process.env.BREVO_SENDER_EMAIL ??= 'newsletter@2dolist.example';
process.env.BREVO_SENDER_NAME ??= '2Dolist';

const { subscribeSchema, preferencesTokenSchema, updatePreferencesSchema } = await import('../src/validation/newsletter.js');
const { buildNewsletterLinks, sendNewsletterWelcomeEmail } = await import('../src/lib/email/newsletter.js');

test('une inscription valide normalise l’adresse et conserve le contexte explicite', () => {
  const value = subscribeSchema.parse({
    email: ' Abonne@EXAMPLE.COM ', language: 'fr', source: 'article', consent: true,
    consentTextVersion: 'v1', interest: 'parachuting', region: 'ile-de-france'
  });
  assert.equal(value.email, 'abonne@example.com');
  assert.equal(value.interest, 'parachuting');
  assert.equal(value.region, 'ile-de-france');
});

test('le consentement false est refusé', () => {
  assert.throws(() => subscribeSchema.parse({ email: 'a@example.com', language: 'fr', source: 'footer', consent: false, consentTextVersion: 'v1' }));
});

test('les intérêts et fréquences invalides sont refusés', () => {
  assert.throws(() => subscribeSchema.parse({ email: 'a@example.com', language: 'fr', source: 'footer', consent: true, consentTextVersion: 'v1', interest: 'car' }));
  assert.throws(() => updatePreferencesSchema.parse({ frequency: 'daily' }));
  assert.throws(() => updatePreferencesSchema.parse({ interests: ['ulm', 'ulm'] }));
});

test('les mises à jour partielles et les sélections relationnelles sont acceptées', () => {
  const value = updatePreferencesSchema.parse({ practical_guides: false, interests: ['ulm', 'helicopter'], regions: ['region-bretagne'] });
  assert.deepEqual(value.interests, ['ulm', 'helicopter']);
  assert.equal(value.practical_guides, false);
});

test('un token absent ou non cryptographique est refusé', () => {
  assert.equal(preferencesTokenSchema.safeParse('bad-token').success, false);
  assert.equal(preferencesTokenSchema.safeParse('a'.repeat(64)).success, true);
});

test('les URLs de préférences suivent le routage localisé et encodent le token', () => {
  assert.deepEqual(buildNewsletterLinks('fr', 'a'.repeat(64)), {
    preferencesUrl: `https://2dolist.example/newsletter/preferences?token=${'a'.repeat(64)}`,
    unsubscribeUrl: `https://2dolist.example/newsletter/preferences?token=${'a'.repeat(64)}&action=unsubscribe`
  });
});

test('Brevo reçoit l’email de bienvenue, ses liens et le timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  await sendNewsletterWelcomeEmail({ email: 'abonne@example.com', language: 'fr', preferencesToken: 'b'.repeat(64) });
  const body = JSON.parse(String(request?.body));
  assert.equal(request?.method, 'POST');
  assert.equal(body.subject, 'Bienvenue sur 2Dolist');
  assert.match(body.htmlContent, /Gérer mes préférences/);
  assert.match(body.htmlContent, /action=unsubscribe/);
});

test('une erreur Brevo est remontée au contrôleur pour journalisation sans secret', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await assert.rejects(sendNewsletterWelcomeEmail({ email: 'abonne@example.com', language: 'fr', preferencesToken: 'c'.repeat(64) }), /status 503/);
});
