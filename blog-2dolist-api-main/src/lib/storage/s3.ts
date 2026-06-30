import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { env } from '../../config/env.js';

const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

const UPLOAD_PREFIX_BY_CONTEXT = {
  cover: 'posts/covers',
  postCover: 'posts/covers',
  editor: 'posts/editor',
  postEditor: 'posts/editor',
  seo: 'seo/open-graph',
  openGraph: 'seo/open-graph',
  avatar: 'authors/avatars',
  authorAvatar: 'authors/avatars',
  misc: 'media/misc'
} as const;

const AWS_S3_PACKAGE = '@aws-sdk/client-s3';
const FILE_TYPE_PACKAGE = 'file-type';

type UploadContext = keyof typeof UPLOAD_PREFIX_BY_CONTEXT;

type S3Config = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucketName: string;
  cloudFrontUrl: string;
};

type S3ClientInstance = {
  send(command: unknown): Promise<unknown>;
};

type AwsS3Module = {
  S3Client: new (config: unknown) => S3ClientInstance;
  PutObjectCommand: new (input: unknown) => unknown;
  DeleteObjectCommand: new (input: unknown) => unknown;
};

type FileTypeModule = {
  fileTypeFromBuffer(buffer: Uint8Array | ArrayBuffer): Promise<{ ext: string; mime: string } | undefined>;
};

export type UploadedS3Image = {
  url: string;
  storageKey: string;
  bucket: string;
  mimeType: string;
  sizeBytes: number;
};

export type UploadImageInput = {
  buffer: Buffer;
  filename?: string;
  declaredMimeType?: string;
  context?: string;
};

export class ImageUploadError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ImageUploadError';
    this.statusCode = statusCode;
  }
}

export class S3StorageError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'S3StorageError';
    this.statusCode = statusCode;
  }
}

async function loadAwsS3Module(): Promise<AwsS3Module> {
  try {
    return (await import(AWS_S3_PACKAGE)) as AwsS3Module;
  } catch (error) {
    throw new S3StorageError(error instanceof Error ? `Dépendance AWS S3 indisponible: ${error.message}` : 'Dépendance AWS S3 indisponible.', 500);
  }
}

async function loadFileTypeModule(): Promise<FileTypeModule> {
  try {
    return (await import(FILE_TYPE_PACKAGE)) as FileTypeModule;
  } catch (error) {
    throw new S3StorageError(error instanceof Error ? `Dépendance file-type indisponible: ${error.message}` : 'Dépendance file-type indisponible.', 500);
  }
}

function getS3Config(): S3Config {
  const missing = [
    ['AWS_ACCESS_KEY_ID', env.AWS_ACCESS_KEY_ID],
    ['AWS_SECRET_ACCESS_KEY', env.AWS_SECRET_ACCESS_KEY],
    ['AWS_REGION', env.AWS_REGION],
    ['AWS_S3_BUCKET_NAME', env.AWS_S3_BUCKET_NAME],
    ['AWS_CLOUDFRONT_URL', env.AWS_CLOUDFRONT_URL]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new S3StorageError(`Configuration AWS S3 incomplète: ${missing.join(', ')}`, 500);
  }

  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    region: env.AWS_REGION!,
    bucketName: env.AWS_S3_BUCKET_NAME!,
    cloudFrontUrl: env.AWS_CLOUDFRONT_URL!
  };
}

async function getS3Client(config: S3Config) {
  const { S3Client } = await loadAwsS3Module();
  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizeCloudFrontUrl(url: string) {
  return url.replace(/\/+$/g, '');
}

export function getUploadPrefix(context?: string): string {
  const normalizedContext = context?.trim() as UploadContext | undefined;
  if (normalizedContext && normalizedContext in UPLOAD_PREFIX_BY_CONTEXT) {
    return UPLOAD_PREFIX_BY_CONTEXT[normalizedContext];
  }
  return UPLOAD_PREFIX_BY_CONTEXT.misc;
}

function getExtensionFromFilename(filename?: string): string | undefined {
  const extension = extname(filename ?? '').replace('.', '').toLowerCase();
  if (!extension) return undefined;
  return extension === 'jpeg' ? 'jpg' : extension;
}

async function validateImage(buffer: Buffer, filename?: string, declaredMimeType?: string) {
  if (!buffer.length) {
    throw new ImageUploadError('Fichier absent ou vide.', 400);
  }

  if (buffer.length > env.AWS_S3_UPLOAD_MAX_BYTES) {
    throw new ImageUploadError(`Fichier trop lourd. Taille maximale: ${env.AWS_S3_UPLOAD_MAX_BYTES} octets.`, 413);
  }

  const { fileTypeFromBuffer } = await loadFileTypeModule();
  const detectedType = await fileTypeFromBuffer(buffer);
  if (!detectedType) {
    throw new ImageUploadError('Type de fichier introuvable ou non supporté.', 415);
  }

  const allowedExtension = ALLOWED_IMAGE_TYPES.get(detectedType.mime);
  if (!allowedExtension) {
    throw new ImageUploadError('Type refusé. Formats acceptés: jpg, jpeg, png, webp.', 415);
  }

  if (declaredMimeType && declaredMimeType !== detectedType.mime) {
    throw new ImageUploadError('Le type MIME déclaré ne correspond pas au contenu réel du fichier.', 415);
  }

  const filenameExtension = getExtensionFromFilename(filename);
  if (filenameExtension && filenameExtension !== allowedExtension) {
    throw new ImageUploadError('Extension refusée ou incohérente avec le contenu du fichier.', 415);
  }

  return {
    mimeType: detectedType.mime,
    extension: allowedExtension
  };
}

function buildStorageKey(prefix: string, extension: string) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${trimSlashes(prefix)}/${year}/${month}/${randomUUID()}.${extension}`;
}

export async function uploadImageToS3(input: UploadImageInput): Promise<UploadedS3Image> {
  const config = getS3Config();
  const { mimeType, extension } = await validateImage(input.buffer, input.filename, input.declaredMimeType);
  const storageKey = buildStorageKey(getUploadPrefix(input.context), extension);
  const { PutObjectCommand } = await loadAwsS3Module();

  try {
    const s3Client = await getS3Client(config);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.bucketName,
        Key: storageKey,
        Body: input.buffer,
        ContentLength: input.buffer.length,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable'
      })
    );
  } catch (error) {
    if (error instanceof S3StorageError) throw error;
    throw new S3StorageError(error instanceof Error ? `Erreur upload AWS S3: ${error.message}` : 'Erreur upload AWS S3.');
  }

  return {
    url: `${normalizeCloudFrontUrl(config.cloudFrontUrl)}/${storageKey}`,
    storageKey,
    bucket: config.bucketName,
    mimeType,
    sizeBytes: input.buffer.length
  };
}

export async function deleteImageFromS3(storageKey: string, bucketName?: string | null) {
  const config = getS3Config();
  const { DeleteObjectCommand } = await loadAwsS3Module();

  try {
    const s3Client = await getS3Client(config);
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName || config.bucketName,
        Key: storageKey
      })
    );
  } catch (error) {
    if (error instanceof S3StorageError) throw error;
    throw new S3StorageError(error instanceof Error ? `Erreur suppression AWS S3: ${error.message}` : 'Erreur suppression AWS S3.');
  }
}
