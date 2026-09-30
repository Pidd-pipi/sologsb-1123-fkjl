import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { MergeBatch, MergeResult, ParsedCard } from '../types/cardMerge';
import type { ImageAsset } from '../types/imageasset';
import {
  MERGE_CHUNK_SIZE,
  buildAssetSnapshot,
  buildMergePlan,
  composeAsset,
  countBlankFilled,
  emptyMergeResult,
} from '../utils/cardMerge';

interface CreateBatchInput {
  cardA: ParsedCard | null;
  cardB: ParsedCard | null;
  tolerance: number;
  simulateFailure: boolean;
}

interface RunOutcome {
  ok: boolean;
  error?: string;
  stats?: MergeResult;
  batch: MergeBatch;
}

interface MergeState {
  batches: MergeBatch[];
  loaded: boolean;
  load: () => Promise<void>;
  createBatch: (input: CreateBatchInput) => Promise<MergeBatch>;
  resolveConflict: (batchId: string, key: string, gsd: number | null) => Promise<void>;
  runBatch: (batchId: string) => Promise<RunOutcome>;
  discardBatch: (batchId: string) => Promise<void>;
}

export const useMergeStore = create<MergeState>((set, get) => ({
  batches: [],
  loaded: false,

  async load() {
    const rows = await db.mergeBatches.orderBy('createdAt').reverse().toArray();
    set({ batches: rows, loaded: true });
  },

  async createBatch({ cardA, cardB, tolerance, simulateFailure }) {
    const [missions, assets] = await Promise.all([db.missions.toArray(), db.assets.toArray()]);
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    const { plan, rejected } = buildMergePlan(cardA, cardB, missions, assets, thumbs, tolerance);
    const now = Date.now();
    const batch: MergeBatch = {
      id: newId('merge'),
      createdAt: now,
      updatedAt: now,
      status: 'staged',
      gsdTolerance: tolerance,
      cardA,
      cardB,
      plan,
      nextChunk: 0,
      chunkSize: MERGE_CHUNK_SIZE,
      attempts: 0,
      simulateFailure,
      lastError: '',
      backup: null,
      rejected,
      finishedAt: null,
    };
    await db.mergeBatches.put(batch);
    set({ batches: [batch, ...get().batches] });
    return batch;
  },

  async resolveConflict(batchId, key, gsd) {
    const batch = get().batches.find((b) => b.id === batchId);
    if (!batch) return;
    const plan = batch.plan.map((p) =>
      p.key === key ? { ...p, resolvedGsd: gsd, status: gsd !== null ? ('ready' as const) : p.status } : p,
    );
    const updated: MergeBatch = { ...batch, plan, updatedAt: Date.now() };
    await db.mergeBatches.put(updated);
    set({ batches: get().batches.map((b) => (b.id === batchId ? updated : b)) });
  },

  async runBatch(batchId) {
    const found = get().batches.find((b) => b.id === batchId);
    if (!found) throw new Error('合并批次不存在');
    if (found.status === 'done' || found.status === 'running' || found.status === 'discarded') {
      return { ok: false, error: '该批次不可执行', batch: found };
    }

    const attempts = found.attempts + 1;
    let batch: MergeBatch = { ...found, attempts, status: 'running', lastError: '', updatedAt: Date.now() };
    await db.mergeBatches.put(batch);
    set({ batches: get().batches.map((b) => (b.id === batchId ? batch : b)) });

    const missions = await db.missions.toArray();
    const lines = await db.lines.toArray();
    const missionById = new Map(missions.map((m) => [m.id, m]));

    const unresolved = batch.plan.filter((p) => p.gsdConflict && p.resolvedGsd === null);
    if (unresolved.length > 0) {
      const guarded: MergeBatch = {
        ...batch,
        status: 'failed',
        lastError: `还有 ${unresolved.length} 个 GSD 冲突未人工选定`,
        updatedAt: Date.now(),
      };
      await db.mergeBatches.put(guarded);
      set({ batches: get().batches.map((b) => (b.id === batchId ? guarded : b)) });
      return { ok: false, error: guarded.lastError, batch: guarded };
    }

    // 首次执行前抓取受影响编目的整库备份（失败后先恢复原编目）
    if (!batch.backup) {
      const missionIds = Array.from(new Set(batch.plan.map((p) => p.missionId).filter((x): x is string => Boolean(x))));
      const [backupAssets, backupThumbs] = await Promise.all([
        db.assets.where('missionId').anyOf(missionIds).toArray(),
        db.thumbs.where('missionId').anyOf(missionIds).toArray(),
      ]);
      batch = {
        ...batch,
        backup: { missionIds, takenAt: Date.now(), assets: backupAssets, thumbs: backupThumbs },
      };
    }

    const originals = (batch.backup!.assets as ImageAsset[]).filter((a) => batch.plan.some((p) => p.newId === a.id));
    const originalByKey = new Map<string, ImageAsset>();
    batch.plan.forEach((p) => {
      const hit = originals.find((a) => a.id === p.newId);
      if (hit) originalByKey.set(p.key, hit);
    });

    const restoreOriginalCatalog = async () => {
      const backup = batch.backup!;
      await db.transaction('rw', [db.assets, db.thumbs], async () => {
        await db.assets.where('missionId').anyOf(backup.missionIds).delete();
        await db.thumbs.where('missionId').anyOf(backup.missionIds).delete();
        if (backup.assets.length) await db.assets.bulkPut(backup.assets as ImageAsset[]);
        if (backup.thumbs.length) await db.thumbs.bulkPut(backup.thumbs as { id: string; missionId: string; dataUrl: string }[]);
      });
    };

    const stats = emptyMergeResult();
    const totalChunks = Math.max(1, Math.ceil(batch.plan.length / batch.chunkSize));

    try {
      for (let c = 0; c < totalChunks; c += 1) {
        // 首次执行的验收用故障：写入第一块后、进入未完成批次前中断
        if (batch.simulateFailure && attempts === 1 && c === 1) {
          throw new Error('模拟写入中断（存储卡校验失败）');
        }
        const slice = batch.plan.slice(c * batch.chunkSize, (c + 1) * batch.chunkSize);
        await db.transaction('rw', [db.assets, db.thumbs], async () => {
          for (const item of slice) {
            if (!item.missionId) continue;
            const mission = missionById.get(item.missionId);
            if (!mission) continue;
            const existing = originalByKey.get(item.key);
            const snapshot = buildAssetSnapshot(
              {
                gsd: existing?.gsd || item.resolvedGsd || item.gsdA || item.gsdB || 0,
                overlap: existing?.overlap || item.cardA?.overlap || item.cardB?.overlap || 0,
                altitude: existing?.altitude || item.cardA?.altitude || item.cardB?.altitude || 0,
                tiltAngle: existing?.tiltAngle || item.cardA?.tiltAngle || item.cardB?.tiltAngle || 0,
                lng: existing?.lng ?? item.cardA?.lng ?? item.cardB?.lng ?? 0,
                lat: existing?.lat ?? item.cardA?.lat ?? item.cardB?.lat ?? 0,
                shotAt: existing?.shotAt || item.cardA?.shotAt || item.cardB?.shotAt || Date.now(),
              },
              mission,
              lines.find((l) => l.missionId === mission.id) ?? null,
              'card-merge',
            );
            const composed = composeAsset(item, existing, batch.id, existing?.snapshot ?? snapshot);
            await db.assets.put(composed);
            if (item.repairThumb) {
              await db.thumbs.put({ id: composed.id, missionId: composed.missionId, dataUrl: item.thumbDataUrl });
            }

            // 统计
            stats.written += 1;
            if (existing) {
              stats.merged += 1;
              stats.blankFilled += countBlankFilled(item, existing);
            } else {
              stats.added += 1;
            }
            if (item.gsdConflict && item.resolvedGsd !== null) stats.conflictsResolved += 1;
            if (item.repairThumb) stats.thumbsRepaired += 1;
          }
        });
        // 记录断点：前 c+1 块已完成
        batch = { ...batch, nextChunk: c + 1, updatedAt: Date.now() };
        await db.mergeBatches.put(batch);
      }

      // 全部块完成：成功，清掉备份
      const done: MergeBatch = { ...batch, status: 'done', backup: null, finishedAt: Date.now(), updatedAt: Date.now() };
      await db.mergeBatches.put(done);
      set({ batches: get().batches.map((b) => (b.id === batchId ? done : b)) });
      return { ok: true, stats, batch: done };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 先恢复原编目，再留存未完成批次（卡片清单、冲突判定、断点都保留）
      await restoreOriginalCatalog();
      const failed: MergeBatch = { ...batch, status: 'failed', lastError: message, updatedAt: Date.now() };
      await db.mergeBatches.put(failed);
      set({ batches: get().batches.map((b) => (b.id === batchId ? failed : b)) });
      return { ok: false, error: message, batch: failed };
    }
  },

  async discardBatch(batchId) {
    await db.mergeBatches.delete(batchId);
    set({ batches: get().batches.filter((b) => b.id !== batchId) });
  },
}));
