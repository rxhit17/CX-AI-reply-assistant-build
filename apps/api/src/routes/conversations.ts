import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import {
  createConversationRequestSchema,
  MAX_IMAGE_BYTES,
  sendMessageRequestSchema,
} from '@cx/shared';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import {
  createConversation,
  getConversationDetail,
  getOrderForConversation,
  listConversations,
  markRead,
  sendMessage,
  setConversationStatus,
  unsendMessage,
  uploadAttachment,
} from '../services/conversations.js';

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  brand_id: z.string().uuid().optional(),
  status: z.enum(['open', 'closed']).optional(),
  q: z.string().trim().max(100).optional(),
});

export async function conversationRoutes(app: FastifyInstance, { db }: Deps) {
  await app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 } });

  app.get('/conversations', async (req) => {
    const filters = listQuery.parse(req.query);
    return { conversations: await listConversations(db, req.user, filters) };
  });

  app.post('/conversations', async (req, reply) => {
    const body = createConversationRequestSchema.parse(req.body);
    const conversation = await createConversation(db, req.user, body);
    return reply.status(201).send({ conversation });
  });

  app.get('/conversations/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return getConversationDetail(db, req.user, id);
  });

  app.patch('/conversations/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { status } = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
    return { conversation: await setConversationStatus(db, req.user, id, status) };
  });

  app.get('/conversations/:id/order', async (req) => {
    const { id } = idParam.parse(req.params);
    return { order: await getOrderForConversation(db, req.user, id) };
  });

  app.post(
    '/conversations/:id/messages',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = sendMessageRequestSchema.parse(req.body);
      const { message, duplicate } = await sendMessage(db, req.user, id, body);
      return reply.status(duplicate ? 200 : 201).send({ message, duplicate });
    },
  );

  app.delete('/conversations/:id/messages/:messageId', async (req) => {
    const { id, messageId } = z
      .object({ id: z.string().uuid(), messageId: z.string().uuid() })
      .parse(req.params);
    return { message: await unsendMessage(db, req.user, id, messageId) };
  });

  app.post(
    '/conversations/:id/attachments',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const file = await req.file();
      if (!file) throw badRequest('No file uploaded', 'NO_FILE');
      const buffer = await file.toBuffer();
      if (file.file.truncated) throw badRequest('File exceeds the 5 MB limit', 'INVALID_FILE');
      const attachment = await uploadAttachment(db, req.user, id, {
        buffer,
        mimetype: file.mimetype,
      });
      return reply.status(201).send({ attachment });
    },
  );

  app.post('/conversations/:id/read', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { reader } = z.object({ reader: z.enum(['agent', 'customer']) }).parse(req.body);
    await markRead(db, req.user, id, reader);
    return reply.status(204).send();
  });
}
