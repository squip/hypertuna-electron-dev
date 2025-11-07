import express from 'express';

import {
  verifySignature,
  stableStringify
} from '../../../shared/escrow/AutobaseKeyEscrowAuth.mjs';

function createEscrowRouter({ service }) {
  if (!service) {
    throw new Error('Escrow router requires a service instance');
  }

  const router = express.Router();

  router.get('/policy', (_req, res) => {
    res.json(service.getPolicySnapshot());
  });

  router.get('/leases', (req, res) => {
    if (!authorizeRequest(req, service)) {
      return res.status(401).json({ error: 'invalid-signature' });
    }
    res.json({ leases: service.listLeases() });
  });

  router.post('/', async (req, res) => {
    if (!authorizeRequest(req, service)) {
      return res.status(401).json({ error: 'invalid-signature' });
    }
    try {
      const result = await service.createDeposit(req.body || {});
      res.status(201).json(result);
    } catch (error) {
      res.status(error?.statusCode || 400).json({
        error: error?.message || 'deposit-failed'
      });
    }
  });

  router.post('/unlock', async (req, res) => {
    if (!authorizeRequest(req, service)) {
      return res.status(401).json({ error: 'invalid-signature' });
    }
    try {
      const result = await service.unlock(req.body || {});
      res.json(result);
    } catch (error) {
      res.status(error?.statusCode || 400).json({
        error: error?.message || 'unlock-failed',
        reasons: error?.reasons || null
      });
    }
  });

  router.post('/revoke', async (req, res) => {
    if (!authorizeRequest(req, service)) {
      return res.status(401).json({ error: 'invalid-signature' });
    }
    try {
      const result = await service.revoke(req.body || {});
      res.json({ success: result });
    } catch (error) {
      res.status(400).json({ error: error?.message || 'revoke-failed' });
    }
  });

  return router;
}

function authorizeRequest(req, service) {
  const secret = service.getSharedSecret();
  const signature = req.headers['x-escrow-signature'];
  const timestamp = req.headers['x-escrow-timestamp'];
  const clientId = req.headers['x-escrow-client-id'] || '';
  const bodyString = stableStringify(req.body || {});
  try {
    return verifySignature({
      secret,
      clientId,
      body: bodyString,
      timestamp,
      signature
    });
  } catch (error) {
    service.logger?.warn?.('[EscrowRouter] Authorization check failed', {
      error: error?.message || error
    });
    return false;
  }
}

export { createEscrowRouter };
