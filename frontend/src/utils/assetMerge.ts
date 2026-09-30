import { db } from './db';
import { newId, stableId } from './id';
import {
  IMAGE_QUALITIES,
  isBlank,
  MERGE_GSD_TOLERANCE,
  makeThumbDataUrl,
  snapshotFromMission,
  type AssetSnapshot,
  type ImageAsset,
  type ImageQuality,
} from '../types/imageasset';
import type {
  CardAsset,
  CardManifest,
  FieldFill,
  GsdConflict,
  MergeField,
  MergeItem,
  MergePlan,
  MergeRun,
  MergeSource,
} from '../types/merge';

/** 合并身份键：任务编号 + 片号（卡片临时编号不是身份） */
export function mergeKey(missionNo: string, imageNo: string): string {
  return `${missionNo}__${imageNo}`;
}

type ScalarField = 'lng' | 'lat' | 'altitude' | 'gsd' | 'overlap' | 'tiltAngle' | 'shotAt' | 'quality' | 'folder';
const SCALAR_FIELDS: ScalarField[] = ['lng', 'lat', 'altitude', 'gsd', 'overlap', 'tiltAngle', 'shotAt', 'quality', 'folder'];
/** 保留字段：已有确认质量 / 实测重叠 / 实测 GSD / 缩略图不被覆盖 */
const STICKY_FIELDS: ScalarField[] = ['quality', 'overlap', 'gsd'];

function asQuality(v: unknown): ImageQuality | undefined {
  return typeof v === 'string' && (IMAGE_QUALITIES as string[]).includes(v) ? (v as ImageQuality) : undefined;
}

function num(v: unknown): number | undefined {
  if (isBlank(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (isBlank(v)) return undefined;
  return String(v);
}

interface SourceValues {
  lng?: number;
  lat?: number;
  altitude?: number;
  gsd?: number;
  overlap?: number;
  tiltAngle?: number;
  shotAt?: number;
  quality?: ImageQuality;
  folder?: string;
}

function extractBase(a: ImageAsset): SourceValues {
  return {
    lng: a.lng,
    lat: a.lat,
    altitude: a.altitude,
    gsd: a.gsd,
    overlap: a.overlap,
    tiltAngle: a.tiltAngle,
    shotAt: a.shotAt,
    quality: a.quality,
    folder: a.folder,
  };
}

function extractCard(c: CardAsset): SourceValues {
  return {
    lng: num(c.lng),
    lat: num(c.lat),
    altitude: num(c.altitude),
    gsd: num(c.gsd),
    overlap: num(c.overlap),
    tiltAngle: num(c.tiltAngle),
    shotAt: num(c.shotAt),
    quality: asQuality(c.quality),
    folder: str(c.folder),
  };
}

/** 单条 (任务编号, 片号) 的合并：空白从另一张补，保留字段不覆盖，GSD 超容差进冲突区 */
function mergeItem(args: {
  missionNo: string;
  imageNo: string;
  base?: ImageAsset;
  baseThumb?: string;
  a?: CardAsset;
  b?: CardAsset;
  tolerance: number;
}): MergeItem {
  const { missionNo, imageNo, base, baseThumb, a, b, tolerance } = args;
  const key = mergeKey(missionNo, imageNo);
  const vBase = base ? extractBase(base) : undefined;
  const vA = a ? extractCard(a) : undefined;
  const vB = b ? extractCard(b) : undefined;

  const values: Partial<Record<MergeField, number | string>> = {};
  const fills: FieldFill[] = [];
  const retained: MergeField[] = [];

  // 标量字段：base（编目已有）优先保留，空白依次从 A、B 补
  for (const field of SCALAR_FIELDS) {
    if (field === 'gsd') continue; // GSD 单独走冲突判定
    const bv = vBase?.[field];
    const av = vA?.[field];
    const cv = vB?.[field];
    if (!isBlank(bv)) {
      values[field] = bv as number | string;
      if (STICKY_FIELDS.includes(field)) retained.push(field);
    } else if (!isBlank(av)) {
      values[field] = av as number | string;
      fills.push({ field, from: 'A' });
    } else if (!isBlank(cv)) {
      values[field] = cv as number | string;
      fills.push({ field, from: 'B' });
    } else {
      // 必填字段兜底，避免写出非法值
      if (field === 'quality') values[field] = '合格';
      else if (field === 'folder') values[field] = '';
      else values[field] = 0;
    }
  }

  // GSD：两卡实测，超容差进冲突区人工选定；否则保留编目/主卡实测值
  const gsdBase = vBase?.gsd;
  const gsdA = vA?.gsd;
  const gsdB = vB?.gsd;
  let conflict: GsdConflict | undefined;
  let gsdValue: number;
  const aPresent = !isBlank(gsdA) && (gsdA as number) > 0;
  const bPresent = !isBlank(gsdB) && (gsdB as number) > 0;
  if (aPresent && bPresent) {
    const av = gsdA as number;
    const bv = gsdB as number;
    const denom = Math.max(Math.abs(av), Math.abs(bv));
    const delta = denom > 0 ? Math.abs(av - bv) / denom : 0;
    if (delta > tolerance) {
      conflict = {
        key,
        imageNo,
        base: !isBlank(gsdBase) ? gsdBase : undefined,
        a: av,
        b: bv,
        delta,
        tolerance,
        pick: undefined, // 必须人工选定后才写入
      };
      gsdValue = !isBlank(gsdBase) ? (gsdBase as number) : av;
    } else {
      gsdValue = !isBlank(gsdBase) ? (gsdBase as number) : av;
      if (!isBlank(gsdBase)) retained.push('gsd');
      else fills.push({ field: 'gsd', from: 'A' });
    }
  } else if (aPresent) {
    gsdValue = !isBlank(gsdBase) ? (gsdBase as number) : (gsdA as number);
    if (!isBlank(gsdBase)) retained.push('gsd');
    else fills.push({ field: 'gsd', from: 'A' });
  } else if (bPresent) {
    gsdValue = !isBlank(gsdBase) ? (gsdBase as number) : (gsdB as number);
    if (!isBlank(gsdBase)) retained.push('gsd');
    else fills.push({ field: 'gsd', from: 'B' });
  } else {
    gsdValue = !isBlank(gsdBase) ? (gsdBase as number) : 0;
    if (!isBlank(gsdBase)) retained.push('gsd');
  }
  values.gsd = gsdValue;

  // 缩略图：编目已有好图保留；断链/缺失时从另一张卡补
  let thumb: string | undefined;
  let thumbFrom: MergeSource | undefined;
  const aThumb = a?.thumb || undefined;
  const bThumb = b?.thumb || undefined;
  if (baseThumb) {
    thumb = baseThumb;
    thumbFrom = 'base';
    retained.push('thumb');
  } else if (aThumb) {
    thumb = aThumb;
    thumbFrom = 'A';
    fills.push({ field: 'thumb', from: 'A' });
  } else if (bThumb) {
    thumb = bThumb;
    thumbFrom = 'B';
    fills.push({ field: 'thumb', from: 'B' });
  }

  return {
    key,
    missionNo,
    imageNo,
    inBase: !!base,
    inA: !!a,
    inB: !!b,
    values,
    thumb,
    thumbFrom,
    fills,
    retained,
    conflict,
  };
}

/** 由两卡清单 + 编目已有条目生成合并方案（纯函数） */
export function buildMergePlan(args: {
  missionNo: string;
  base: ImageAsset[];
  baseThumbs: Record<string, string>;
  cardA: CardManifest;
  cardB: CardManifest;
  tolerance?: number;
}): MergePlan {
  const { missionNo, base, baseThumbs, cardA, cardB, tolerance = MERGE_GSD_TOLERANCE } = args;
  const baseByNo = new Map<string, ImageAsset>();
  base.forEach((a) => baseByNo.set(a.imageNo, a));
  const aByNo = new Map<string, CardAsset>();
  cardA.assets.forEach((c) => {
    if (c.imageNo) aByNo.set(c.imageNo, c);
  });
  const bByNo = new Map<string, CardAsset>();
  cardB.assets.forEach((c) => {
    if (c.imageNo) bByNo.set(c.imageNo, c);
  });

  const nos = new Set<string>([...baseByNo.keys(), ...aByNo.keys(), ...bByNo.keys()]);
  const items: MergeItem[] = [];
  nos.forEach((imageNo) => {
    const b = baseByNo.get(imageNo);
    items.push(
      mergeItem({
        missionNo,
        imageNo,
        base: b,
        baseThumb: b ? baseThumbs[b.id] : undefined,
        a: aByNo.get(imageNo),
        b: bByNo.get(imageNo),
        tolerance,
      }),
    );
  });
  items.sort((x, y) => x.imageNo.localeCompare(y.imageNo, 'zh-Hans-CN', { numeric: true }));

  const conflicts = items.map((i) => i.conflict).filter((c): c is GsdConflict => !!c);
  const stats = {
    total: items.length,
    matched: items.filter((i) => (i.inBase ? 1 : 0) + (i.inA ? 1 : 0) + (i.inB ? 1 : 0) >= 2).length,
    onlyA: items.filter((i) => !i.inBase && i.inA && !i.inB).length,
    onlyB: items.filter((i) => !i.inBase && !i.inA && i.inB).length,
    fillCount: items.reduce((s, i) => s + i.fills.length, 0),
    retainedCount: items.reduce((s, i) => s + i.retained.length, 0),
    conflictCount: conflicts.length,
  };
  return { missionNo, tolerance, items, conflicts, stats };
}

/** 人工处理 GSD 冲突：选定后才允许写入 */
export function resolveConflict(plan: MergePlan, key: string, pick: MergeSource): MergePlan {
  const item = plan.items.find((i) => i.key === key);
  if (!item || !item.conflict) return plan;
  const conflict = item.conflict;
  if (pick === 'base' && conflict.base === undefined) return plan;
  const chosen = pick === 'base' ? conflict.base : pick === 'A' ? conflict.a : conflict.b;
  if (chosen === undefined) return plan;
  conflict.pick = pick;
  item.values.gsd = chosen;
  return plan;
}

/** 方案是否可写入：所有冲突都已人工选定 */
export function planWritable(plan: MergePlan): boolean {
  return plan.conflicts.every((c) => !!c.pick);
}

/** 把合并方案落为完整条目 + 缩略图（新条目用确定性 id，保证重试幂等） */
export function planToAssets(
  plan: MergePlan,
  missionId: string,
  snapshot: AssetSnapshot,
  existingByKey: Map<string, ImageAsset>,
): { assets: ImageAsset[]; thumbs: { id: string; missionId: string; dataUrl: string }[] } {
  const assets: ImageAsset[] = [];
  const thumbs: { id: string; missionId: string; dataUrl: string }[] = [];
  for (const item of plan.items) {
    const existing = existingByKey.get(item.key);
    const id = existing?.id ?? stableId('asset', item.key);
    const v = item.values;
    const quality = (v.quality as ImageQuality) ?? '合格';
    const asset: ImageAsset = {
      id,
      missionId,
      imageNo: item.imageNo,
      lng: Number(v.lng ?? 0),
      lat: Number(v.lat ?? 0),
      altitude: Number(v.altitude ?? 0),
      gsd: Number(v.gsd ?? 0),
      overlap: Number(v.overlap ?? 0),
      tiltAngle: Number(v.tiltAngle ?? 0),
      shotAt: Number(v.shotAt ?? 0),
      quality,
      folder: v.folder !== undefined ? String(v.folder) : '',
      // 实测值（gsd/overlap）来自卡片/编目，绝不因相机参数变更而回算；快照仅溯源
      snapshot: existing?.snapshot ?? snapshot,
    };
    assets.push(asset);
    // 缩略图：优先保留好图，缺失则生成占位图，杜绝断链
    const dataUrl = item.thumb || makeThumbDataUrl(item.imageNo, quality, asset.lng, asset.lat);
    thumbs.push({ id, missionId, dataUrl });
  }
  return { assets, thumbs };
}

/** 卡片清单文本解析（JSON 或 CSV） */
export function parseCardManifest(text: string, fallbackLabel = '卡'): { ok: boolean; manifest?: CardManifest; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '清单为空' };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed);
      if (Array.isArray(obj)) {
        return {
          ok: true,
          manifest: { cardLabel: fallbackLabel, missionNo: '', assets: obj.map(coerceCardAsset) },
        };
      }
      const missionNo = String(obj.missionNo ?? obj.mission ?? '');
      const rawAssets = Array.isArray(obj.assets) ? obj.assets : Array.isArray(obj.items) ? obj.items : [];
      return {
        ok: true,
        manifest: {
          cardLabel: String(obj.cardLabel ?? obj.label ?? fallbackLabel),
          missionNo,
          assets: rawAssets.map(coerceCardAsset),
        },
      };
    } catch (e) {
      return { ok: false, error: 'JSON 解析失败：' + (e as Error).message };
    }
  }
  return parseCsv(trimmed, fallbackLabel);
}

function coerceCardAsset(o: any): CardAsset {
  return {
    tempId: o.tempId != null ? String(o.tempId) : o.id != null ? String(o.id) : undefined,
    imageNo: String(o.imageNo ?? o.image_no ?? o['片号'] ?? ''),
    lng: o.lng != null ? Number(o.lng) : o.lon != null ? Number(o.lon) : null,
    lat: o.lat != null ? Number(o.lat) : null,
    altitude: o.altitude != null ? Number(o.altitude) : o.alt != null ? Number(o.alt) : null,
    gsd: o.gsd != null ? Number(o.gsd) : null,
    overlap: o.overlap != null ? Number(o.overlap) : null,
    tiltAngle: o.tiltAngle != null ? Number(o.tiltAngle) : o.tilt != null ? Number(o.tilt) : null,
    shotAt: o.shotAt != null ? Number(o.shotAt) : null,
    quality: o.quality ?? null,
    folder: o.folder != null ? String(o.folder) : null,
    thumb: o.thumb != null ? String(o.thumb) : o.thumbnail != null ? String(o.thumbnail) : null,
  };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
      }
    } else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string, fallbackLabel: string): { ok: boolean; manifest?: CardManifest; error?: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { ok: false, error: 'CSV 至少需要表头与一行数据' };
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const assets: CardAsset[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    assets.push(coerceCardAsset(row));
  }
  let missionNo = '';
  const missionCol = header.find((h) => h === 'missionNo' || h === '任务编号');
  if (missionCol) {
    const first = lines[1] ? splitCsvLine(lines[1])[header.indexOf(missionCol)] : '';
    missionNo = (first ?? '').trim();
  }
  return { ok: true, manifest: { cardLabel: fallbackLabel, missionNo, assets } };
}

/** 生成两卡示例清单（用于演示）：含匹配、空白补齐、保留、GSD 冲突、断链缩略图、仅 A/仅 B */
export function buildSampleCards(missionNo: string, base: ImageAsset[]): { cardA: CardManifest; cardB: CardManifest } {
  const mk = (a: ImageAsset, overrides: Partial<CardAsset> = {}): CardAsset => ({
    tempId: `TEMP_${Math.random().toString(36).slice(2, 8)}`,
    imageNo: a.imageNo,
    lng: a.lng,
    lat: a.lat,
    altitude: a.altitude,
    gsd: a.gsd,
    overlap: a.overlap,
    tiltAngle: a.tiltAngle,
    shotAt: a.shotAt,
    quality: a.quality,
    folder: a.folder,
    thumb: undefined,
    ...overrides,
  });
  const cardA: CardManifest = { cardLabel: 'A 卡', missionNo, assets: [] };
  const cardB: CardManifest = { cardLabel: 'B 卡', missionNo, assets: [] };
  base.forEach((a, idx) => {
    if (idx === 1) {
      // IMG_1002：两卡实测 GSD 相差超容差 → 冲突区
      cardA.assets.push(mk(a, { gsd: a.gsd }));
      cardB.assets.push(mk(a, { gsd: Number((a.gsd * 1.12).toFixed(2)) }));
    } else if (idx === 2) {
      // IMG_1003：B 卡缩略图断链、质量字段不同（编目已确认质量保留）
      cardA.assets.push(
        mk(a, {
          thumb: 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#2f6f4f"/><text x="10" y="26" font-size="15" fill="#fff">${a.imageNo} A卡</text></svg>`),
        }),
      );
      cardB.assets.push(mk(a, { quality: '合格', thumb: null }));
    } else if (idx === 4) {
      // IMG_1005：仅 A 卡
      cardA.assets.push(mk(a, {}));
    } else if (idx === 5) {
      // IMG_1006：仅 B 卡
      cardB.assets.push(mk(a, {}));
    } else {
      // IMG_1001 / IMG_1004：两卡共有；B 卡部分字段空白，从 A 补
      cardA.assets.push(mk(a, {}));
      cardB.assets.push(mk(a, { lng: null, lat: null, altitude: null, overlap: null }));
    }
  });
  // IMG_1007：新片，两卡共有；B 卡仅含片号与 GSD，其余空白从 A 补
  const extra: ImageAsset = {
    id: '',
    missionId: '',
    imageNo: 'IMG_1007',
    lng: 116.399,
    lat: 39.902,
    altitude: 120,
    gsd: 3.25,
    overlap: 74,
    tiltAngle: 3,
    shotAt: Date.now(),
    quality: '合格',
    folder: `/${missionNo}/100MEDIA`,
  };
  cardA.assets.push(mk(extra, {}));
  cardB.assets.push(mk(extra, { lng: null, lat: null, altitude: null, overlap: null, tiltAngle: null, shotAt: null, quality: null, folder: null }));
  // IMG_1008：新片，仅 B 卡且字段不全
  cardB.assets.push(mk({ ...extra, imageNo: 'IMG_1008', lng: 116.4, lat: 39.901, gsd: 3.18 }, { tiltAngle: null, shotAt: null }));
  return { cardA, cardB };
}

export interface ApplyOptions {
  onProgress?: (done: number, total: number) => void;
  /** 测试专用：在指定批次（从 0 起）写入成功后注入失败，用于验证恢复原编目 */
  failAfterBatch?: number;
}

/**
 * 把合并方案写入编目（分批 + 断点续作 + 失败回滚）。
 * - 身份键 (任务编号, 片号)：新条目用确定性 id，重试幂等不重复；
 * - 失败后恢复本任务原编目，再重试即从未完成批次继续。
 */
export async function applyMergePlan(plan: MergePlan, missionId: string, opts: ApplyOptions = {}): Promise<{ runId: string }> {
  const mission = await db.missions.get(missionId);
  if (!mission) throw new Error('任务不存在，无法写入编目');
  if (!planWritable(plan)) throw new Error('存在未处理的 GSD 冲突，请先在冲突区选定后再写入');

  const snapshot = snapshotFromMission(mission, 'collection');
  const existing = await db.assets.where('missionId').equals(missionId).toArray();
  const existingByKey = new Map<string, ImageAsset>();
  existing.forEach((a) => existingByKey.set(mergeKey(mission.missionNo, a.imageNo), a));
  const { assets, thumbs } = planToAssets(plan, missionId, snapshot, existingByKey);

  const beforeAssets = existing;
  const beforeThumbs = await db.thumbs.where('missionId').equals(missionId).toArray();

  const BATCH = 40;
  const batches: ImageAsset[][] = [];
  for (let i = 0; i < assets.length; i += BATCH) batches.push(assets.slice(i, i + BATCH));
  const thumbIdsByBatch = batches.map((batch) => new Set(batch.map((a) => a.id)));

  // 查找未完成运行（断点续作）
  const prevRuns = await db.mergeRuns.where('missionId').equals(missionId).toArray();
  const prev = prevRuns
    .filter((r) => r.status === 'applying' || r.status === 'failed')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const startBatch = prev ? prev.doneBatches.length : 0;
  const runId = prev?.id ?? newId('merge');
  const now = Date.now();
  const run: MergeRun = {
    id: runId,
    missionId,
    missionNo: plan.missionNo,
    status: 'applying',
    tolerance: plan.tolerance,
    plan,
    doneBatches: prev?.doneBatches ?? [],
    totalBatches: batches.length,
    beforeAssets,
    beforeThumbs,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  await db.mergeRuns.put(run);

  try {
    for (let i = startBatch; i < batches.length; i += 1) {
      await db.transaction('rw', [db.assets, db.thumbs, db.mergeRuns], async () => {
        await db.assets.bulkPut(batches[i]);
        await db.thumbs.bulkPut(thumbs.filter((t) => thumbIdsByBatch[i].has(t.id)));
        run.doneBatches.push(i);
        run.updatedAt = Date.now();
        await db.mergeRuns.put(run);
      });
      opts.onProgress?.(i + 1, batches.length);
      if (opts.failAfterBatch === i) throw new Error('__injected_failure__');
    }
    run.status = 'done';
    run.updatedAt = Date.now();
    await db.mergeRuns.put(run);
    return { runId };
  } catch (e) {
    // 失败：恢复本任务原编目
    await rollbackMerge(run, assets);
    throw e;
  }
}

/** 回滚：把本任务条目/缩略图恢复到合并前状态 */
async function rollbackMerge(run: MergeRun, plannedAssets: ImageAsset[]): Promise<void> {
  const beforeIds = new Set(run.beforeAssets.map((a) => a.id));
  const plannedIds = plannedAssets.map((a) => a.id);
  const toDelete = plannedIds.filter((id) => !beforeIds.has(id));
  await db.transaction('rw', [db.assets, db.thumbs, db.mergeRuns], async () => {
    await db.assets.bulkPut(run.beforeAssets);
    if (toDelete.length) await db.assets.bulkDelete(toDelete);
    await db.thumbs.bulkPut(run.beforeThumbs);
    if (toDelete.length) await db.thumbs.bulkDelete(toDelete);
    run.status = 'rolled_back';
    run.doneBatches = [];
    run.updatedAt = Date.now();
    run.error = undefined;
    await db.mergeRuns.put(run);
  });
}

/** 旧数据升级：为缺快照的条目补录快照（source=legacy），绝不回算实测值 */
export function ensureAssetSnapshot(
  asset: ImageAsset,
  mission: Parameters<typeof snapshotFromMission>[0],
): ImageAsset {
  if (asset.snapshot) return asset;
  return {
    ...asset,
    snapshot: snapshotFromMission(mission, 'legacy'),
  };
}
