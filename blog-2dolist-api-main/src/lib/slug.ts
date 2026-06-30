import slugify from 'slugify';

export function makeSlug(input: string): string {
  return slugify(input, { lower: true, strict: true, trim: true });
}
