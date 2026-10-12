// SPDX-License-Identifier: Apache-2.0
import type { Env, RepoInfo, RepoToken } from './env';
import { artifacts } from './artifacts';
import { HttpError } from './auth';
import { Store } from './store';

export const MIN_DEMO_TTL = 120;
export const MAX_DEMO_TTL = 3600;
export const CLEANUP_BATCH = 100;
type Lifetime = { createdAt: string; expiresAt: string; closedAt?: string; reason?: string };
export type CredentialRecord = {
  receipt: string; id: string | null; repo: string; owner: string;
  type: 'canonical-read' | 'fork-write' | 'engine-read' | 'engine-write' | 'sandbox-read' | 'bootstrap' | 'legacy-fork';
  createdAt: string; expiresAt: string | null; status: 'issuing' | 'active' | 'revoke-pending' | 'revoked' | 'expired' | 'unknown';
  attempts: number; uncertainty?: 'create-response' | 'bootstrap-id-unavailable' | 'tracking-failed' | 'legacy-expiry-unavailable';
};
export function demoTtl(env: Pick<Env, 'DEMO_CREDENTIAL_TTL_SECONDS'>): number {
  const raw = env.DEMO_CREDENTIAL_TTL_SECONDS;
  if (raw === undefined) return MAX_DEMO_TTL;
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < MIN_DEMO_TTL || Number(raw) > MAX_DEMO_TTL) throw new HttpError(503, 'invalid_demo_credential_ttl');
  return Number(raw);
}

// The ledger contains only revocable IDs and bounded lifetime metadata, never
// bearer values. A pre-create receipt makes ambiguous provider responses visible.
export class DemoCredentials {
  constructor(private env: Env, private store: Store) {}
  initialize(): Lifetime {
    const ttl = demoTtl(this.env), existing = this.store.get<Lifetime>('meta', 'credentialLifetime');
    if (existing) { this.assertOpen(); return existing; }
    if (this.store.get('meta', 'project')) throw new HttpError(410, 'project_closed');
    const now = Date.now(), createdAt = new Date(now).toISOString(), expiresAt = new Date(now + ttl * 1000).toISOString();
    const value = { createdAt, expiresAt }; this.store.put('meta', 'credentialLifetime', value); return value;
  }
  lifetime(): Lifetime | undefined { return this.store.get<Lifetime>('meta', 'credentialLifetime'); }
  isOpen(): boolean {
    const value = this.lifetime();
    return !!value && !value.closedAt && Number.isFinite(Date.parse(value.createdAt)) && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.createdAt) <= Date.now() && Date.parse(value.expiresAt) > Date.now() && Date.parse(value.expiresAt) > Date.parse(value.createdAt) && Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= MAX_DEMO_TTL * 1000;
  }
  assertOpen(): void { demoTtl(this.env); if (!this.isOpen()) throw new HttpError(410, 'project_closed'); }
  close(reason = 'operator-cleanup'): void {
    const prior = this.lifetime();
    if (!prior?.closedAt) this.store.put('meta', 'credentialLifetime', { ...(prior ?? { createdAt: '', expiresAt: '' }), closedAt: new Date().toISOString(), reason });
    this.store.storage.sql.exec('UPDATE agents SET keyHash=NULL,keyExpiresAt=NULL');
  }
  enforce(): boolean {
    if (!this.isOpen() && (this.lifetime() || this.store.get('meta', 'project'))) { this.close(this.lifetime() ? 'expired-or-invalid-lifetime' : 'legacy-lifetime-unavailable'); return false; }
    return this.isOpen();
  }
  private save(value: CredentialRecord): void {
    const previous = this.store.get<CredentialRecord>('credentials', value.receipt);
    // Concurrent cleanup/lease-finally retries cannot undo confirmed closure.
    if (previous && ['revoked', 'expired'].includes(previous.status)) value.status = previous.status;
    this.store.put('credentials', value.receipt, value);
  }
  noteExistingRepository(repo: string): void { this.store.put('meta', `credentialInventoryUnknown:${repo}`, repo); }
  records(): CredentialRecord[] { return this.store.all<CredentialRecord>('credentials'); }
  private async durable(value: CredentialRecord): Promise<void> { this.save(value); await this.store.storage.sync(); }
  private async rescue(value: CredentialRecord): Promise<void> {
    // Independent durable fallback for a failed SQL ledger write. If storage is
    // unavailable entirely, the pre-written unknown receipt remains; no secret
    // is returned and no claim that every provider ID was captured is made.
    await this.store.storage.put(`credential-debt:${value.receipt}`, value);
  }
  async importDebt(): Promise<void> {
    const entries = await this.store.storage.list<CredentialRecord>({ prefix: 'credential-debt:', limit: CLEANUP_BATCH });
    for (const [key, value] of entries) { await this.durable(value); await this.store.storage.delete(key); }
  }
  private async begin(repo: string, owner: string, type: CredentialRecord['type'], expiresAt: string | null): Promise<CredentialRecord> {
    this.assertOpen();
    const value: CredentialRecord = { receipt: crypto.randomUUID(), id: null, repo, owner, type, createdAt: new Date().toISOString(), expiresAt, status: 'issuing', attempts: 0, uncertainty: 'create-response' };
    await this.durable(value); return value;
  }
  async issue(repoName: string, scope: 'read' | 'write', type: CredentialRecord['type'], owner: string, maximum = MAX_DEMO_TTL): Promise<RepoToken> {
    this.assertOpen();
    let ttl = Math.min(demoTtl(this.env), maximum, Math.floor((Date.parse(this.lifetime()!.expiresAt) - Date.now()) / 1000) - 1);
    // Artifacts' minimum TTL is 60 seconds. Never extend the project to refresh.
    if (ttl < 60) throw new HttpError(410, 'credential_window_ending');
    const receipt = await this.begin(repoName, owner, type, null);
    let token: RepoToken, attempted = false;
    try {
      using repo = await artifacts(this.env).get(repoName); this.assertOpen();
      // Leave a second for service/clock rounding; verify the returned expiry
      // strictly as well, since an arbitrarily slow provider is not bounded.
      ttl = Math.min(ttl, Math.floor((Date.parse(this.lifetime()!.expiresAt) - Date.now()) / 1000) - 1);
      if (ttl < 60) throw new HttpError(410, 'credential_window_ending');
      attempted = true; token = await repo.createToken(scope, ttl);
    } catch (error) {
      if (!attempted) { receipt.status = 'revoked'; delete receipt.uncertainty; await this.durable(receipt); throw error; }
      receipt.status = 'unknown'; receipt.expiresAt = null; this.close('credential-issuance-uncertain');
      await this.durable(receipt); throw new HttpError(503, 'credential_issuance_uncertain');
    }
    const expiry = Date.parse(token.expiresAt);
    const knownId = typeof token.id === 'string' && !!token.id && token.id !== token.plaintext ? token.id : null;
    const safe = !!knownId && typeof token.plaintext === 'string' && !!token.plaintext && Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.parse(this.lifetime()!.expiresAt) && this.isOpen();
    const tracked: CredentialRecord = { ...receipt, id: knownId, expiresAt: Number.isFinite(expiry) ? token.expiresAt : null, status: safe ? 'active' : 'revoke-pending' };
    delete tracked.uncertainty;
    try { await this.durable(tracked); }
    catch {
      tracked.status = 'revoke-pending'; tracked.uncertainty = 'tracking-failed';
      // Compensate before propagating any error, even if every write fails.
      await this.compensate(tracked, token.id || token.plaintext);
      throw new HttpError(503, 'credential_tracking_failed');
    }
    if (!safe) { await this.compensate(tracked, token.id || token.plaintext); throw new HttpError(503, 'invalid_provider_credential'); }
    if (!this.isOpen()) { await this.compensate(tracked, token.id || token.plaintext); throw new HttpError(410, 'project_closed'); }
    return token;
  }
  private async compensate(value: CredentialRecord, revocable: string): Promise<void> {
    value.attempts++;
    try { using repo = await artifacts(this.env).get(value.repo); value.status = await repo.revokeToken(revocable) ? 'revoked' : 'revoke-pending'; }
    catch { value.status = 'revoke-pending'; }
    try { await this.durable(value); } catch { try { await this.rescue(value); } catch { /* Pre-create receipt remains uncertain, never falsely complete. */ } }
  }
  // create/fork bootstrap credentials have no guaranteed ID/expiry in this
  // binding. Revoke their returned bearer immediately; never save that bearer.
  async bootstrap(repoName: string, create: () => Promise<RepoInfo & { token?: string }>): Promise<RepoInfo> {
    const receipt = await this.begin(repoName, 'bootstrap', 'bootstrap', null);
    let result: RepoInfo & { token?: string }, attempted = false;
    try { this.assertOpen(); attempted = true; result = await create(); }
    catch (error) {
      if (!attempted) { receipt.status = 'revoked'; delete receipt.uncertainty; await this.durable(receipt); throw error; }
      receipt.status = 'unknown'; this.close('bootstrap-create-uncertain'); await this.durable(receipt); throw new HttpError(503, 'bootstrap_issuance_uncertain');
    }
    if (result.token) {
      receipt.uncertainty = 'bootstrap-id-unavailable';
      await this.compensate(receipt, result.token);
      if (receipt.status !== 'revoked') { this.close('bootstrap-revocation-pending'); throw new HttpError(503, 'bootstrap_revocation_pending'); }
    } else { receipt.status = 'revoked'; delete receipt.uncertainty; await this.durable(receipt); }
    this.assertOpen();
    const { token: ignored, ...info } = result; return info;
  }
  async revoke(repo: string, id: string): Promise<void> {
    const value = this.records().find(row => row.repo === repo && row.id === id);
    if (!value) throw new HttpError(503, 'untracked_credential');
    if (['revoked', 'expired'].includes(value.status)) return;
    value.status = 'revoke-pending'; await this.durable(value); await this.compensate(value, id);
  }
  async sweep(all = false, orphanedLeases = false): Promise<void> {
    await this.importDebt();
    if (orphanedLeases && this.records().some(row => !row.id && ['issuing', 'unknown'].includes(row.status))) {
      this.close('credential-issuance-uncertain'); all = true;
    }
    // Preserve old fork IDs on migration; do not invent their expiry or erase
    // evidence of historical untracked canonical/bootstrap credentials.
    for (const lane of this.store.rows<{ tokenId: string; forkRepo: string; id: string }>('SELECT id,tokenId,forkRepo FROM lanes WHERE tokenId IS NOT NULL')) {
      if (!this.records().some(r => r.id === lane.tokenId && r.repo === lane.forkRepo)) await this.durable({ receipt: crypto.randomUUID(), id: lane.tokenId, repo: lane.forkRepo, owner: lane.id, type: 'legacy-fork', createdAt: '', expiresAt: null, status: 'revoke-pending', attempts: 0, uncertainty: 'legacy-expiry-unavailable' });
    }
    let attempts = 0;
    for (const row of this.records().sort((a, b) => a.attempts - b.attempts)) {
      if (['revoked', 'expired'].includes(row.status)) continue;
      if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) { row.status = 'expired'; await this.durable(row); continue; }
      if (row.id && (all || row.status === 'revoke-pending' || orphanedLeases && (row.type.startsWith('engine-') || row.type === 'sandbox-read'))) {
        if (attempts++ >= CLEANUP_BATCH) continue;
        await this.revoke(row.repo, row.id);
      }
    }
  }
  status() {
    const records = this.records(), outstanding = records.filter(r => !['revoked', 'expired'].includes(r.status));
    const lifetime = this.lifetime();
    const inventoryUnknownRepositories = this.store.rows<{ data: string }>("SELECT data FROM meta WHERE key LIKE 'credentialInventoryUnknown:%'").map(r => JSON.parse(r.data) as string);
    const legacyInventoryUnknown = lifetime?.reason === 'legacy-lifetime-unavailable';
    return { scope: 'app-issued-git-and-agent-http-auth', retained: ['git-repositories', 'native-proof', 'custodial-native-signing-keys'], lifetime, open: this.isOpen(), complete: !this.isOpen() && !outstanding.length && !legacyInventoryUnknown && !inventoryUnknownRepositories.length, legacyInventoryUnknown, inventoryUnknownRepositories,
      outstanding: outstanding.length, revocationPending: outstanding.filter(r => !!r.id).length, unknownIssuance: outstanding.filter(r => !r.id).length,
      expiryFallbackAssumesProviderEnforcement: true,
      expiredFallback: records.filter(r => r.status === 'expired').length, total: records.length, records: outstanding.slice(0, CLEANUP_BATCH), truncated: outstanding.length > CLEANUP_BATCH };
  }
  nextCheck(): number | undefined {
    const pending = this.records().filter(r => !['revoked', 'expired'].includes(r.status));
    const retryable = pending.some(r => !!r.id && (!this.isOpen() || r.status === 'revoke-pending'));
    const expiries = pending.flatMap(r => r.expiresAt && Date.parse(r.expiresAt) > Date.now() ? [Date.parse(r.expiresAt)] : []);
    const next = Math.min(this.isOpen() ? Date.parse(this.lifetime()!.expiresAt) : Infinity, retryable ? Date.now() + 3000 : Infinity, ...expiries);
    return Number.isFinite(next) ? next : undefined;
  }
}
