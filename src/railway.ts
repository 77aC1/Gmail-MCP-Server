#!/usr/bin/env node

import http from 'http';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const config = {
  clientId: process.env.GMAIL_CLIENT_ID || '',
  clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
  refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
  userEmail: process.env.GMAIL_USER_EMAIL || '',
  port: parseInt(process.env.PORT || '8080', 10),
};

if (!config.clientId || !config.clientSecret || !config.refreshToken) {
  console.error('ERROR: Missing required Gmail credentials.');
  console.error('Set: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER_EMAIL');
  process.exit(1);
}

const oauth2Client = new OAuth2Client(
  config.clientId,
  config.clientSecret,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: config.refreshToken });

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

const sseConnections = new Map<string, http.ServerResponse>();

function extractEmailContent(messagePart: any): { text: string; html: string } {
  let textContent = '';
  let htmlContent = '';
  if (messagePart.body && messagePart.body.data) {
    const content = Buffer.from(messagePart.body.data, 'base64').toString('utf8');
    if (messagePart.mimeType === 'text/plain') textContent = content;
    else if (messagePart.mimeType === 'text/html') htmlContent = content;
  }
  if (messagePart.parts) {
    for (const part of messagePart.parts) {
      const { text, html } = extractEmailContent(part);
      if (text) textContent += text;
      if (html) htmlContent += html;
    }
  }
  return { text: textContent, html: htmlContent };
}

const TOOLS = [
  {
    name: 'send_email',
    description: 'Sends a new email via Gmail. Supports plain text, HTML, CC, BCC.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body content' },
        htmlBody: { type: 'string', description: 'HTML version of body' },
        cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'BCC recipients' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'read_email',
    description: 'Read the full content of a specific email by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the email to retrieve' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails using Gmail search syntax. Examples: "from:someone@example.com", "after:2024/01/01 has:attachment"',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        maxResults: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_email_labels',
    description: 'List all Gmail labels (system and user-defined).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'modify_email',
    description: 'Modify email labels (archive, mark as important, move to folder, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the email' },
        addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'delete_email',
    description: 'Permanently delete an email.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the email to delete' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'verify_connection',
    description: 'Verify Gmail API connection is working.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case 'send_email': {
      const toList = args.to || [];
      const subject = args.subject || '';
      const body = args.body || '';
      const htmlBody = args.htmlBody || '';
      const ccList = args.cc || [];
      const bccList = args.bcc || [];

      let raw: string;
      if (htmlBody) {
        const boundary = 'boundary_' + Date.now();
        const parts = [
          `From: ${config.userEmail}`,
          `To: ${toList.join(', ')}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          body,
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"',
          '',
          htmlBody,
          `--${boundary}--`,
        ];
        if (ccList.length) parts.splice(3, 0, `Cc: ${ccList.join(', ')}`);
        if (bccList.length) parts.splice(4, 0, `Bcc: ${bccList.join(', ')}`);
        raw = parts.join('\r\n');
      } else {
        const headers = [
          `From: ${config.userEmail}`,
          `To: ${toList.join(', ')}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset="UTF-8"',
          '',
          body,
        ];
        if (ccList.length) headers.splice(2, 0, `Cc: ${ccList.join(', ')}`);
        if (bccList.length) headers.splice(3, 0, `Bcc: ${bccList.join(', ')}`);
        raw = headers.join('\r\n');
      }

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });

      return { content: [{ type: 'text', text: `Email sent successfully! ID: ${response.data.id}` }] };
    }

    case 'read_email': {
      const response = await gmail.users.messages.get({
        userId: 'me', id: args.messageId, format: 'full',
      });
      const headers = response.data.payload?.headers || [];
      const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
      const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
      const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
      const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
      const threadId = response.data.threadId || '';
      const { text, html } = extractEmailContent(response.data.payload || {});
      const content = text || html || '(No readable content)';
      return {
        content: [{ type: 'text', text: `Thread ID: ${threadId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${content}` }],
      };
    }

    case 'search_emails': {
      const response = await gmail.users.messages.list({
        userId: 'me', q: args.query, maxResults: args.maxResults || 10,
      });
      const messages = response.data.messages || [];
      if (messages.length === 0) return { content: [{ type: 'text', text: 'No emails found.' }] };
      const results = await Promise.all(
        messages.map(async (msg: any) => {
          const detail = await gmail.users.messages.get({
            userId: 'me', id: msg.id!, format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          });
          const hdrs = detail.data.payload?.headers || [];
          return {
            id: msg.id,
            subject: hdrs.find((h: any) => h.name === 'Subject')?.value || '',
            from: hdrs.find((h: any) => h.name === 'From')?.value || '',
            date: hdrs.find((h: any) => h.name === 'Date')?.value || '',
          };
        })
      );
      const formatted = results.map(r => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`).join('\n');
      return { content: [{ type: 'text', text: `Found ${results.length} emails:\n\n${formatted}` }] };
    }

    case 'list_email_labels': {
      const response = await gmail.users.labels.list({ userId: 'me' });
      const labels = response.data.labels || [];
      const system = labels.filter((l: any) => l.type === 'system');
      const user = labels.filter((l: any) => l.type === 'user');
      return {
        content: [{
          type: 'text',
          text: `Total: ${labels.length} labels\n\nSystem:\n${system.map((l: any) => `- ${l.name} (${l.id})`).join('\n')}\n\nUser:\n${user.map((l: any) => `- ${l.name} (${l.id})`).join('\n')}`,
        }],
      };
    }

    case 'modify_email': {
      const body: any = {};
      if (args.addLabelIds) body.addLabelIds = args.addLabelIds;
      if (args.removeLabelIds) body.removeLabelIds = args.removeLabelIds;
      await gmail.users.messages.modify({ userId: 'me', id: args.messageId, requestBody: body });
      return { content: [{ type: 'text', text: `Email ${args.messageId} updated.` }] };
    }

    case 'delete_email': {
      await gmail.users.messages.delete({ userId: 'me', id: args.messageId });
      return { content: [{ type: 'text', text: `Email ${args.messageId} deleted.` }] };
    }

    case 'verify_connection': {
      try {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        return { content: [{ type: 'text', text: `Connected! Email: ${profile.data.emailAddress}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Connection failed: ${e.message}` }] };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcpMessage(message: any): Promise<any> {
  const { method, params } = message;
  if (method === 'initialize') {
    return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'gmail-mcp-server', version: '1.0.0-railway' } };
  }
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') return await handleToolCall(params.name, params.arguments || {});
  if (method === 'ping') return {};
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  return {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'gmail-mcp-server', email: config.userEmail ? config.userEmail.substring(0, 4) + '***' : 'not set' }));
    return;
  }

  if (url.pathname === '/sse' && req.method === 'GET') {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseConnections.set(sessionId, res);
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); } }, 25000);
    req.on('close', () => { clearInterval(keepalive); sseConnections.delete(sessionId); });
    return;
  }

  if ((url.pathname === '/mcp' || url.pathname === '/sse') && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const message = JSON.parse(body);
        const result = await handleMcpMessage(message);
        if (result === null) { res.writeHead(202); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: error.message } }));
      }
    });
    return;
  }

  if (url.pathname === '/message' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const message = JSON.parse(body);
        const result = await handleMcpMessage(message);
        if (result === null) { res.writeHead(202); res.end(); return; }
        const response = { jsonrpc: '2.0', id: message.id, result };
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId && sseConnections.has(sessionId)) {
          sseConnections.get(sessionId)!.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: error.message } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(config.port, () => {
  console.log(`\n🚀 Gmail MCP Server running on port ${config.port}`);
  console.log(`📧 Email: ${config.userEmail || 'NOT SET'}`);
  console.log(`\n🔗 Endpoints:`);
  console.log(`   Health:  http://0.0.0.0:${config.port}/`);
  console.log(`   SSE:     http://0.0.0.0:${config.port}/sse`);
  console.log(`   HTTP:    http://0.0.0.0:${config.port}/mcp`);
  console.log(`\n✅ Ready for MCP connections!`);
});
