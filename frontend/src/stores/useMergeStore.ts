import { create } from 'zustand';
import type { ImageAsset } from '../types/imageasset';
import type { CardManifest, MergePlan, MergeRun, MergeSource } from '../types/merge';
import {
  applyMergePlan,
  buildMergePlan,
  buildSampleCards,
  parseCardManifest,
  planWritable,
  resolveConflict,
} from '../utils/assetMerge';
import { db } from '../utils/db';

interface MergeState {
  cardAText: string;
  cardBText: string;
  cardA?: CardManifest;
  cardB?: CardManifest;
  plan?: MergePlan;
  writable: boolean;
  applying: boolean;
  progress: number;
  runId?: string;
  runStatus?: MergeRun['status'];
  error: string;
  toast: string;

  setCardAText: (v: string) => void;
  setCardBText: (v: string) => void;
  parseCard: (side: 'A' | 'B') => { ok: boolean; error?: string };
  loadSample: (missionNo: string, base: ImageAsset[]) => void;
  buildPlan: (missionNo: string, base: ImageAsset[], baseThumbs: Record<string, string>) => void;
  resolve: (key: string, pick: MergeSource) => void;
  apply: (missionId: string) => Promise<void>;
  reset: () => void;
  clearToast: () => void;
}

export const useMergeStore = create<MergeState>((set, get) => ({
  cardAText: '',
  cardBText: '',
  cardA: undefined,
  cardB: undefined,
  plan: undefined,
  writable: false,
  applying: false,
  progress: 0,
  runId: undefined,
  runStatus: undefined,
  error: '',
  toast: '',

  setCardAText: (v) => set({ cardAText: v }),
  setCardBText: (v) => set({ cardBText: v }),

  parseCard: (side) => {
    const text = side === 'A' ? get().cardAText : get().cardBText;
    const parsed = parseCardManifest(text, side === 'A' ? 'A 卡' : 'B 卡');
    if (!parsed.ok || !parsed.manifest) {
      set({ error: `${side} 卡清单解析失败：${parsed.error ?? ''}` });
      return { ok: false, error: parsed.error };
    }
    const manifest = parsed.manifest;
    if (side === 'A') set({ cardA: manifest, error: '' });
    else set({ cardB: manifest, error: '' });
    return { ok: true };
  },

  loadSample: (missionNo, base) => {
    const { cardA, cardB } = buildSampleCards(missionNo, base);
    set({
      cardA,
      cardB,
      cardAText: JSON.stringify(cardA, null, 2),
      cardBText: JSON.stringify(cardB, null, 2),
      plan: undefined,
      writable: false,
      error: '',
      toast: '已载入两卡示例清单（含匹配、空白补齐、保留、GSD 冲突、断链缩略图、仅 A/仅 B）',
    });
  },

  buildPlan: (missionNo, base, baseThumbs) => {
    const { cardA, cardB } = get();
    if (!cardA || !cardB) {
      set({ error: '请先分别解析 A 卡与 B 卡清单' });
      return;
    }
    if (cardA.missionNo && cardB.missionNo && cardA.missionNo !== cardB.missionNo) {
      set({ error: `两卡任务编号不一致：A 卡 ${cardA.missionNo}，B 卡 ${cardB.missionNo}` });
      return;
    }
    const plan = buildMergePlan({ missionNo, base, baseThumbs, cardA, cardB });
    set({ plan, writable: planWritable(plan), error: '', toast: `已生成合并方案：${plan.stats.total} 个片号，冲突 ${plan.stats.conflictCount} 处` });
  },

  resolve: (key, pick) => {
    const plan = get().plan;
    if (!plan) return;
    resolveConflict(plan, key, pick);
    set({ plan: { ...plan, items: [...plan.items], conflicts: [...plan.conflicts] }, writable: planWritable(plan) });
  },

  apply: async (missionId) => {
    const plan = get().plan;
    if (!plan) return;
    if (!planWritable(plan)) {
      set({ error: '存在未处理的 GSD 冲突，请先在冲突区选定后再写入' });
      return;
    }
    set({ applying: true, progress: 0, error: '' });
    try {
      const { runId } = await applyMergePlan(plan, missionId, {
        onProgress: (done, total) => set({ progress: total ? done / total : 1 }),
      });
      const run = await db.mergeRuns.get(runId);
      set({
        applying: false,
        progress: 1,
        runId,
        runStatus: run?.status ?? 'done',
        toast: run?.status === 'rolled_back' ? '写入失败，已恢复原编目，可重试' : '两卡合并完成，台账、成果页与导出已同步',
      });
    } catch (e) {
      // 失败后已恢复原编目；记录状态供断点续作
      const runs = await db.mergeRuns.where('missionId').equals(missionId).toArray();
      const latest = runs.sort((a, b) => b.createdAt - a.createdAt)[0];
      set({
        applying: false,
        runId: latest?.id,
        runStatus: latest?.status ?? 'rolled_back',
        error: `合并失败，已恢复原编目：${(e as Error).message}。可重试，写入为幂等不会重复。`,
        toast: '',
      });
    }
  },

  reset: () =>
    set({
      cardAText: '',
      cardBText: '',
      cardA: undefined,
      cardB: undefined,
      plan: undefined,
      writable: false,
      applying: false,
      progress: 0,
      runId: undefined,
      runStatus: undefined,
      error: '',
      toast: '',
    }),

  clearToast: () => set({ toast: '' }),
}));
