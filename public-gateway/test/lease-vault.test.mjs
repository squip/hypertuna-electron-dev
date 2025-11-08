import test from 'node:test';
import assert from 'node:assert/strict';

import LeaseVault from '../../shared/escrow/LeaseVault.mjs';

test('LeaseVault redacts writer secrets and exposes digests', () => {
  const vault = new LeaseVault({ handleProcessSignals: false, label: 'test-vault' });
  const lease = vault.track({
    relayKey: 'relay-1',
    leaseId: 'lease-1',
    writerPackage: {
      writerKey: 'aabbccdd',
      ownerPeerKey: 'peer-1'
    }
  });

  assert.ok(Buffer.isBuffer(lease.writerPackage.writerKey), 'Lease should include secure writer key buffer');
  assert.ok(lease.writerPackage.writerKeyDigest, 'Lease should include writerKeyDigest');

  const summaries = vault.list();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].relayKey, 'relay-1');
  assert.equal(summaries[0].payloadDigest, lease.writerPackage.writerKeyDigest);
  assert.equal(
    summaries[0].writerPackage?.writerKey,
    undefined,
    'Redacted lease summary should not expose writer secret'
  );

  vault.destroy();
});

test('LeaseVault release clears stored leases', () => {
  const vault = new LeaseVault({ handleProcessSignals: false, label: 'test-vault-release' });
  vault.track({
    relayKey: 'relay-2',
    leaseId: 'lease-2',
    writerPackage: {
      writerKey: 'ffeeccbb'
    }
  });

  assert.ok(vault.get('relay-2', { includeSecret: true }));
  const released = vault.release('relay-2', 'unit-test');
  assert.equal(released?.leaseId, 'lease-2');
  assert.equal(vault.get('relay-2'), null);
  assert.equal(vault.list().length, 0);

  vault.destroy();
});

test('LeaseVault releaseByEscrowId clears matching entries', () => {
  const vault = new LeaseVault({ handleProcessSignals: false, label: 'test-vault-release-escrow' });
  vault.track({
    relayKey: 'relay-escrow',
    leaseId: 'lease-escrow',
    escrowId: 'escrow-123',
    expiresAt: Date.now() + 1000
  });
  vault.track({
    relayKey: 'relay-other',
    leaseId: 'lease-other',
    escrowId: 'escrow-999',
    expiresAt: Date.now() + 1000
  });

  const released = vault.releaseByEscrowId('escrow-123', 'unit-test');
  assert.equal(released.length, 1);
  assert.equal(released[0].leaseId, 'lease-escrow');
  assert.equal(vault.get('relay-escrow'), null);
  assert.ok(vault.get('relay-other'));

  vault.destroy();
});

test('LeaseVault releaseExpired prunes stale leases', () => {
  const vault = new LeaseVault({ handleProcessSignals: false, label: 'test-vault-expire' });
  const now = Date.now();
  vault.track({
    relayKey: 'expired-relay',
    leaseId: 'expired-lease',
    expiresAt: now - 10
  });
  vault.track({
    relayKey: 'fresh-relay',
    leaseId: 'fresh-lease',
    expiresAt: now + 10_000
  });

  const released = vault.releaseExpired(now);
  assert.equal(released.length, 1);
  assert.equal(released[0].leaseId, 'expired-lease');
  assert.equal(vault.get('expired-relay'), null);
  assert.ok(vault.get('fresh-relay'));

  vault.destroy();
});
