import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    isMultipart(): boolean;
    parts(): AsyncIterable<
      | {
          type: 'file';
          fieldname: string;
          filename: string;
          mimetype: string;
          toBuffer(): Promise<Buffer>;
        }
      | {
          type: 'field';
          fieldname: string;
          value: unknown;
        }
    >;
  }
}
