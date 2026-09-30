import type { FlightLine } from '../types/flightline';
import type { Mission } from '../types/mission';
import {
  makeThumbDataUrl,
  type AssetSnapshotSource,
  type ImageAsset,
  type ImageQuality,
} from '../types/imageasset';
import type {
  CardRow,
  CardSlot,
  MergePlanItem,
  MergeResult,
  ParsedCard,
} from '../types/cardMerge';
import { newId } from './id';

/** GSD 容差默认值 cm/px（两卡实测差超过该值进入冲突区） */
export const DEFAULT_GSD_TOLERANCE = 0.3;
export const MERGE_CHUNK_SIZE = 6;

const HEADER_ALIASES: Record<string, keyof CardRow> = {
  卡片临时编号: 'cardNo',
  临时编号: 'cardNo',
  卡号: 'cardNo',
  cardno: 'cardNo',
  任务编号: 'missionNo',
  任务号: 'missionNo',
  missionno: 'missionNo',
  片号: 'imageNo',
  影像片号: 'imageNo',
  imageno: 'imageNo',
  经度: 'lng',
  lng: 'lng',
  lon: 'lng',
  纬度: 'lat',
  lat: 'lat',
  航高: 'altitude',
  航高m: 'altitude',
  altitude: 'altitude',
  实测gsd: 'gsd',
  gsd: 'gsd',
  'gsdcm/px': 'gsd',
  实测重叠: 'overlap',
  实测重叠率: 'overlap',
  重叠率: 'overlap',
  overlap: 'overlap',
  倾角: 'tiltAngle',
  tiltangle: 'tiltAngle',
  拍摄时间: 'shotAt',
  拍照时间: 'shotAt',
  shotat: 'shotAt',
  质量: 'quality',
  quality: 'quality',
  归档目录: 'folder',
  目录: 'folder',
  folder: 'folder',
};

const QUALITY_VALUES: ImageQuality[] = ['合格', '模糊', '过曝'];

function splitLine(line: string): string[] {
  // 支持制表符 / 逗号 / 分号分隔；行首行尾的空单元格必须保留
  return line.split(/\t|[,;]/).map((s) => s.trim());
}

/** 兼容 "2024-09-12 10:20:30" / ISO / 纯时间戳；解析不出返回 null */
function parseShotAt(raw: string): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

/** 数值字段：空白、非数字一律按缺测处理（除经纬度，缺了直接判该行无效） */
function numOrNull(raw: string): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析一张卡的清单文本（首行表头，列名兼容中英文别名）。
 * 同卡内相同（任务编号, 片号）的行会折叠为一行，重复数记录在 duplicateInCard。
 */
export function parseCardManifest(text: string, slot: CardSlot): ParsedCard {
  const lines = text
    .split(/\r?\n/)
    // 不能对整行 trim：行首分隔符前的空单元格是有效空字段
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
  const invalidRows: ParsedCard['invalidRows'] = [];
  if (lines.length === 0) return { slot, rows: [], invalidRows };

  const headers = splitLine(lines[0]).map((h) => HEADER_ALIASES[h.toLowerCase()] ?? (HEADER_ALIASES[h] as keyof CardRow | undefined));

  const rows: CardRow[] = [];
  const indexByKey = new Map<string, number>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i]);
    const get = (field: keyof CardRow): string => {
      const idx = headers.indexOf(field);
      return idx >= 0 ? cells[idx]?.trim() ?? '' : '';
    };
    const cardNo = get('cardNo') || `卡${slot}`;
    const missionNo = get('missionNo');
    const imageNo = get('imageNo');

    if (!imageNo) {
      invalidRows.push({ lineNo: i + 1, reason: '缺少片号', raw: lines[i] });
      continue;
    }
    // 缺任务编号不在此拦截：作为可解析行保留，计划阶段按身份规则拒收并提示
    const lngRaw = get('lng');
    const latRaw = get('lat');
    if (lngRaw === '' || latRaw === '' || !Number.isFinite(Number(lngRaw)) || !Number.isFinite(Number(latRaw))) {
      invalidRows.push({ lineNo: i + 1, reason: '经纬度缺失或非法', raw: lines[i] });
      continue;
    }
    const lng = Number(lngRaw);
    const lat = Number(latRaw);
    const qualityRaw = get('quality');
    const quality = qualityRaw ? (QUALITY_VALUES.includes(qualityRaw as ImageQuality) ? (qualityRaw as ImageQuality) : null) : null;

    const row: CardRow = {
      cardNo,
      missionNo,
      imageNo,
      lng,
      lat,
      altitude: numOrNull(get('altitude')) ?? 0,
      gsd: numOrNull(get('gsd')),
      overlap: numOrNull(get('overlap')),
      tiltAngle: numOrNull(get('tiltAngle')) ?? 0,
      shotAt: parseShotAt(get('shotAt')),
      quality,
      folder: get('folder'),
      duplicateInCard: 0,
    };

    const key = `${missionNo}␟${imageNo}`;
    const existedIdx = indexByKey.get(key);
    if (existedIdx === undefined) {
      indexByKey.set(key, rows.length);
      rows.push(row);
    } else {
      // 同卡重复片号：空白字段从后一行补，实测值已存在则保留先到的（相机参数差异不覆盖）
      const prev = rows[existedIdx];
      rows[existedIdx] = {
        ...prev,
        cardNo: prev.cardNo || row.cardNo,
        altitude: prev.altitude || row.altitude,
        gsd: prev.gsd ?? row.gsd,
        overlap: prev.overlap ?? row.overlap,
        tiltAngle: prev.tiltAngle || row.tiltAngle,
        shotAt: prev.shotAt ?? row.shotAt,
        quality: prev.quality ?? row.quality,
        folder: prev.folder || row.folder,
        duplicateInCard: prev.duplicateInCard + 1,
      };
    }
  }

  return { slot, rows, invalidRows };
}

const identityKey = (missionNo: string, imageNo: string) => `${missionNo.trim()}␟${imageNo.trim()}`;

/** 取第一个非空实测值 */
function firstMeasured(...values: (number | null)[]): number {
  for (const v of values) {
    if (v !== null && v !== undefined && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * 依据两卡清单 + 当前编目生成合并计划：
 * - 身份 = 任务编号 + 片号（卡片临时编号不参与）
 * - 已收条目保留：已确认质量、实测重叠率、已填实测 GSD 不被卡片覆盖
 * - 两卡实测 GSD 差超过容差 → 冲突项，必须人工选定
 */
export function buildMergePlan(
  cardA: ParsedCard | null,
  cardB: ParsedCard | null,
  missions: Mission[],
  existingAssets: ImageAsset[],
  thumbs: Record<string, string>,
  tolerance: number,
): { plan: MergePlanItem[]; rejected: { missionNo: string; imageNo: string; cardNo: string; reason: string }[] } {
  const missionByNo = new Map(missions.map((m) => [m.missionNo.trim(), m]));
  const existingIndex = new Map<string, ImageAsset>();
  existingAssets.forEach((a) => {
    const mission = missions.find((m) => m.id === a.missionId);
    if (mission) existingIndex.set(identityKey(mission.missionNo, a.imageNo), a);
  });

  const groups = new Map<string, { missionNo: string; imageNo: string; cardA?: CardRow; cardB?: CardRow }>();
  const rejected: { missionNo: string; imageNo: string; cardNo: string; reason: string }[] = [];

  const collect = (card: ParsedCard | null) => {
    if (!card) return;
    card.rows.forEach((row) => {
      if (!row.missionNo.trim()) {
        rejected.push({ missionNo: '（空白）', imageNo: row.imageNo, cardNo: row.cardNo, reason: '缺少任务编号' });
        return;
      }
      if (!missionByNo.has(row.missionNo.trim())) {
        rejected.push({ missionNo: row.missionNo, imageNo: row.imageNo, cardNo: row.cardNo, reason: '任务编号在台账中不存在' });
        return;
      }
      const key = identityKey(row.missionNo, row.imageNo);
      const group = groups.get(key) ?? { missionNo: row.missionNo.trim(), imageNo: row.imageNo.trim() };
      if (card.slot === 'A') group.cardA = row;
      else group.cardB = row;
      groups.set(key, group);
    });
  };
  collect(cardA);
  collect(cardB);

  const plan: MergePlanItem[] = [];
  groups.forEach((group) => {
    const key = identityKey(group.missionNo, group.imageNo);
    const mission = missionByNo.get(group.missionNo)!;
    const existing = existingIndex.get(key);
    const gsdA = group.cardA?.gsd ?? null;
    const gsdB = group.cardB?.gsd ?? null;
    // 已收实测 GSD 保留：只有编目缺测时才让两卡互相比较
    const gsdConflict = !existing?.gsd && gsdA !== null && gsdB !== null && Math.abs(gsdA - gsdB) > tolerance;

    const a = group.cardA;
    const b = group.cardB;
    const baseLng = existing?.lng ?? (firstMeasured(a?.lng ?? null, b?.lng ?? null) || 0);
    const baseLat = existing?.lat ?? (firstMeasured(a?.lat ?? null, b?.lat ?? null) || 0);
    const repairThumb = !existing || !thumbs[existing.id];

    plan.push({
      key,
      missionNo: group.missionNo,
      missionId: mission.id,
      imageNo: group.imageNo,
      existing: Boolean(existing),
      newId: existing?.id ?? newId('asset'),
      cardA: group.cardA,
      cardB: group.cardB,
      gsdConflict,
      gsdA,
      gsdB,
      gsdExisting: existing?.gsd ? existing.gsd : null,
      resolvedGsd: null,
      status: gsdConflict ? 'conflict' : 'ready',
      duplicateInCard: (a?.duplicateInCard ?? 0) + (b?.duplicateInCard ?? 0),
      repairThumb,
      thumbDataUrl: makeThumbDataUrl(
        group.imageNo,
        existing?.quality ?? a?.quality ?? b?.quality ?? '合格',
        baseLng,
        baseLat,
      ),
    });
  });

  plan.sort((x, y) => x.key.localeCompare(y.key, 'zh-Hans-CN', { numeric: true }));
  return { plan, rejected };
}

export function planStats(plan: MergePlanItem[]) {
  return {
    total: plan.length,
    added: plan.filter((p) => !p.existing).length,
    merged: plan.filter((p) => p.existing).length,
    conflicts: plan.filter((p) => p.gsdConflict).length,
    unresolved: plan.filter((p) => p.gsdConflict && p.resolvedGsd === null).length,
    thumbRepair: plan.filter((p) => p.repairThumb).length,
  };
}

/** 合并后实际补齐的空白字段数（用于结果统计） */
export function countBlankFilled(item: MergePlanItem, existing: ImageAsset | undefined): number {
  if (!existing) return 0;
  const a = item.cardA;
  const b = item.cardB;
  let n = 0;
  if (!existing.overlap && firstMeasured(a?.overlap ?? null, b?.overlap ?? null)) n += 1;
  if (!existing.altitude && firstMeasured(a?.altitude ?? null, b?.altitude ?? null)) n += 1;
  if (!existing.tiltAngle && firstMeasured(a?.tiltAngle ?? null, b?.tiltAngle ?? null)) n += 1;
  if (!existing.folder && (a?.folder || b?.folder)) n += 1;
  if (!existing.shotAt && (a?.shotAt ?? b?.shotAt ?? null)) n += 1;
  if (!existing.gsd && item.resolvedGsd !== null) n += 1;
  return n;
}

/**
 * 按规则合成最终影像条目（纯函数，失败重试时重复执行结果一致）：
 * 已确认质量 / 实测重叠率 / 已填实测 GSD / 缩略图保留；空白从卡A再卡B补齐。
 */
export function composeAsset(
  item: MergePlanItem,
  existing: ImageAsset | undefined,
  batchId: string,
  snapshot: ImageAsset['snapshot'],
): ImageAsset {
  const a = item.cardA;
  const b = item.cardB;
  const cardNos = [a?.cardNo, b?.cardNo].filter((c): c is string => Boolean(c));

  // 实测 GSD：已收保留（最高优先）；冲突时取人工选定；否则卡A再卡B补齐空白
  const gsd = existing?.gsd || item.resolvedGsd || firstMeasured(item.gsdA, item.gsdB);
  // 实测重叠率：已收（含已确认）一律保留，绝不拿航线设计重叠率回算
  const overlap = existing?.overlap || firstMeasured(a?.overlap ?? null, b?.overlap ?? null);
  const altitude = existing?.altitude || firstMeasured(a?.altitude ?? null, b?.altitude ?? null);
  const tiltAngle = existing?.tiltAngle || firstMeasured(a?.tiltAngle ?? null, b?.tiltAngle ?? null);
  const lng = existing?.lng ?? firstMeasured(a?.lng ?? null, b?.lng ?? null);
  const lat = existing?.lat ?? firstMeasured(a?.lat ?? null, b?.lat ?? null);
  const shotAt = existing?.shotAt || a?.shotAt || b?.shotAt || Date.now();
  const folder = existing?.folder || a?.folder || b?.folder || '';
  const cardNo = existing?.cardNo || a?.cardNo || b?.cardNo || cardNos[0] || '';

  // 已确认质量保留；未确认时接受卡片带回的质检结论
  const qualityConfirmed = existing?.qualityConfirmed ?? false;
  const quality: ImageQuality = qualityConfirmed
    ? existing!.quality
    : existing?.quality && existing.quality !== '合格'
      ? existing.quality
      : a?.quality ?? b?.quality ?? existing?.quality ?? '合格';
  // 卡片带回了明确质检结论即视为已确认
  const nextConfirmed = qualityConfirmed || Boolean(a?.quality ?? b?.quality);

  const sourceCardNos = Array.from(new Set([...(existing?.sourceCardNos ?? []), ...cardNos]));
  const snapshotFilled = existing?.snapshotFilled ?? true;
  // 快照一旦建立即冻结，不随后来改过的相机/航线参数改写
  const nextSnapshot = existing?.snapshot ?? snapshot;

  return {
    id: item.newId,
    missionId: item.missionId ?? existing!.missionId,
    imageNo: item.imageNo,
    cardNo,
    sourceCardNos,
    lng,
    lat,
    altitude,
    gsd,
    overlap,
    tiltAngle,
    shotAt,
    quality,
    qualityConfirmed: nextConfirmed,
    folder,
    mergeBatchId: batchId,
    snapshotFilled: Boolean(nextSnapshot) || snapshotFilled,
    snapshot: nextSnapshot,
  };
}

/** 入藏时构建成果快照：冻结当时的相机、航线参数与实测值（不做任何重算） */
export function buildAssetSnapshot(
  asset: Pick<ImageAsset, 'gsd' | 'overlap' | 'altitude' | 'tiltAngle' | 'lng' | 'lat' | 'shotAt'>,
  mission: Mission,
  line: FlightLine | null,
  source: AssetSnapshotSource,
): NonNullable<ImageAsset['snapshot']> {
  return {
    filledAt: Date.now(),
    source,
    mission: {
      missionNo: mission.missionNo,
      cameraModel: mission.cameraModel,
      sensorWidth: mission.sensorWidth,
      sensorHeight: mission.sensorHeight,
      focalLength: mission.focalLength,
      pixelSize: mission.pixelSize,
    },
    line: line
      ? {
          lineNo: line.lineNo,
          overlapForward: line.overlapForward,
          overlapSide: line.overlapSide,
          gsd: line.gsd,
          spacing: line.spacing,
          photoInterval: line.photoInterval,
          updatedAt: line.updatedAt,
        }
      : null,
    measured: {
      gsd: asset.gsd,
      overlap: asset.overlap,
      altitude: asset.altitude,
      tiltAngle: asset.tiltAngle,
      lng: asset.lng,
      lat: asset.lat,
      shotAt: asset.shotAt,
    },
  };
}

/** 汇总执行统计 */
export function emptyMergeResult(): MergeResult {
  return { written: 0, merged: 0, added: 0, conflictsResolved: 0, thumbsRepaired: 0, blankFilled: 0 };
}
