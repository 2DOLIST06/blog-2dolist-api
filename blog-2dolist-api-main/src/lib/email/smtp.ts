import net from 'node:net';
import tls from 'node:tls';
import { env } from '../../config/env.js';

type SmtpSocket = net.Socket | tls.TLSSocket;

type SendEmailOptions = {
  from: string;
  to: string | string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
};

const CRLF = '\r\n';

function encodeHeader(value: string) {
  return /[^\x20-\x7E]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
}

function encodeAddress(address: string) {
  return address.trim();
}

function normalizeRecipients(to: string | string[]) {
  const recipients = Array.isArray(to) ? to : to.split(',');
  return recipients.map((recipient) => recipient.trim()).filter(Boolean);
}

function assertSmtpConfigured() {
  if (!env.SMTP_SERVER || !env.SMTP_USERNAME || !env.SMTP_PASSWORD || !env.MAIL_FROM) {
    throw new Error('SMTP is not configured. Define SMTP_SERVER, SMTP_USERNAME, SMTP_PASSWORD and MAIL_FROM.');
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function textToHtml(text: string) {
  return `<html><body><pre style="font-family: Arial, sans-serif; white-space: pre-wrap;">${escapeHtml(text)}</pre></body></html>`;
}

function buildMessage(options: SendEmailOptions) {
  const boundary = `tmt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const recipients = normalizeRecipients(options.to);
  const headers = [
    `From: ${encodeAddress(options.from)}`,
    `To: ${recipients.map(encodeAddress).join(', ')}`,
    ...(options.replyTo ? [`Reply-To: ${encodeAddress(options.replyTo)}`] : []),
    `Subject: ${encodeHeader(options.subject)}`,
    'MIME-Version: 1.0',
    options.html ? `Content-Type: multipart/alternative; boundary="${boundary}"` : 'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit'
  ];

  if (!options.html) {
    return `${headers.join(CRLF)}${CRLF}${CRLF}${options.text}`;
  }

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    options.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    options.html,
    `--${boundary}--`,
    ''
  ];

  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

function dotStuff(message: string) {
  return message.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

function readResponse(socket: SmtpSocket): Promise<{ code: number; response: string }> {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      reject(new Error('SMTP connection timed out.'));
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;

      const lastLine = lines[lines.length - 1];
      if (/^\d{3} /.test(lastLine)) {
        cleanup();
        resolve({ code: Number(lastLine.slice(0, 3)), response: buffer });
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
  });
}

async function command(socket: SmtpSocket, line: string, expectedCodes: number[]) {
  socket.write(`${line}${CRLF}`);
  const response = await readResponse(socket);
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP command failed (${line}): ${response.response.trim()}`);
  }
  return response;
}

function connect(host: string, port: number) {
  return new Promise<SmtpSocket>((resolve, reject) => {
    const socket =
      port === 465
        ? tls.connect({ host, port, servername: host }, () => resolve(socket))
        : net.createConnection({ host, port }, () => resolve(socket));

    socket.setTimeout(30000);
    socket.once('error', reject);
  });
}

function startTls(socket: net.Socket, host: string) {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: host }, () => resolve(secureSocket));
    secureSocket.setTimeout(30000);
    secureSocket.once('error', reject);
  });
}

export async function sendEmail(options: SendEmailOptions) {
  assertSmtpConfigured();
  const host = env.SMTP_SERVER as string;
  const port = env.SMTP_PORT;
  const recipients = normalizeRecipients(options.to);

  if (!recipients.length) throw new Error('At least one recipient is required.');

  let socket = await connect(host, port);

  try {
    await readResponse(socket);
    await command(socket, `EHLO ${env.SMTP_EHLO_DOMAIN}`, [250]);

    if (port !== 465) {
      await command(socket, 'STARTTLS', [220]);
      socket = await startTls(socket as net.Socket, host);
      await command(socket, `EHLO ${env.SMTP_EHLO_DOMAIN}`, [250]);
    }

    await command(socket, 'AUTH LOGIN', [334]);
    await command(socket, Buffer.from(env.SMTP_USERNAME as string, 'utf8').toString('base64'), [334]);
    await command(socket, Buffer.from(env.SMTP_PASSWORD as string, 'utf8').toString('base64'), [235]);
    await command(socket, `MAIL FROM:<${options.from}>`, [250]);

    for (const recipient of recipients) {
      await command(socket, `RCPT TO:<${recipient}>`, [250, 251]);
    }

    await command(socket, 'DATA', [354]);
    socket.write(`${dotStuff(buildMessage(options))}${CRLF}.${CRLF}`);
    const dataResponse = await readResponse(socket);
    if (dataResponse.code !== 250) {
      throw new Error(`SMTP DATA failed: ${dataResponse.response.trim()}`);
    }

    await command(socket, 'QUIT', [221]);
  } finally {
    socket.end();
  }
}
