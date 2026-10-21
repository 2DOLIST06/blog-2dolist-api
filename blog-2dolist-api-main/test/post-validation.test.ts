import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters';
const { postSchema } = await import('../src/validation/admin.js');

const editorialSchema = postSchema.pick({ excerpt: true, chapoHtml: true });
for (const value of ['', 'a', 'Texte libre. '.repeat(1000), null, undefined]) {
  test(`résumé et chapeau sans contrainte de longueur (${value?.length ?? String(value)})`, () => {
    assert.deepEqual(editorialSchema.parse({ excerpt: value, chapoHtml: value }), { excerpt: value, chapoHtml: value });
  });
}
