import type { ImageQuality } from './imageasset';

/** A / B 两张外业存储卡 */
export type CardSlot = 'A' | 'B';

/** 卡片清单解析后的一行（同卡同任务同片号已折叠） */
export interface CardRow {
  cardNo: string;
  missionNo: string;
  imageNo: string;
  lng: number;
  lat: number;
  altitude: number;
  /** 实测 GSD cm/px；缺测为 null */
  gsd: number | null;
  /** 实测重叠率 %；缺测为 null */
  overlap: number | null;
  tiltAngle: number;
  shotAt: number | null;
  quality: ImageQuality | null;
  folder: string;
  /** 解析时折叠掉的同卡重复行数 */
  duplicateInCard: number;
}

export interface ParsedCard {
  slot: CardSlot;
  rows: CardRow[];
  /** 无法解析的原始行（1 起，不含表头） */
  invalidRows: { lineNo: number; reason: string; raw: string }[];
}

/** 合并计划项：身份 = 任务编号 + 片号，与卡片临时编号无关 */
export interface MergePlanItem {
  key: string;
  missionNo: string;
  /** 归一到的任务 id；任务编号在台账里不存在时为 null，该项不允许写入 */
  missionId: string | null;
  imageNo: string;
  existing: boolean;
  /** 新增条目预先分配的稳定 id，断点重试时复用 */
  newId: string;
  cardA?: CardRow;
  cardB?: CardRow;
  /** 两卡实测 GSD 差是否超过容差 */
  gsdConflict: boolean;
  gsdA: number | null;
  gsdB: number | null;
  /** 已收编目中的实测 GSD（存在即保留，不参与冲突判定） */
  gsdExisting: number | null;
  /** 人工选定的 GSD；冲突项必须选择后才能写入 */
  resolvedGsd: number | null;
  status: 'pending' | 'conflict' | 'ready';
  /** 同卡内重复片号折叠的总行数（用于提示） */
  duplicateInCard: number;
  /** 合并时需要补的缩略图（新增条目或原编目断链） */
  repairThumb: boolean;
  thumbDataUrl: string;
}

/** 合并前对受影响编目做的整库备份（失败后先恢复原编目） */
export interface CatalogBackup {
  missionIds: string[];
  takenAt: number;
  assets: unknown[];
  thumbs: unknown[];
}

export type MergeBatchStatus = 'staged' | 'running' | 'failed' | 'done' | 'discarded';

/** 两卡合并批次：卡片清单、计划、冲突判定与断点都在这里留存 */
export interface MergeBatch {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: MergeBatchStatus;
  gsdTolerance: number;
  cardA: ParsedCard | null;
  cardB: ParsedCard | null;
  plan: MergePlanItem[];
  /** 下一个未完成的批次下标（分块写入，每块一个事务） */
  nextChunk: number;
  chunkSize: number;
  attempts: number;
  /** 仅首次执行时生效的失败模拟（验收失败恢复用） */
  simulateFailure: boolean;
  lastError: string;
  /** 首次执行前抓取的原编目备份；成功后清空 */
  backup: CatalogBackup | null;
  /** 任务编号在台账不存在等被拒行（任务编号+片号+卡号） */
  rejected: { missionNo: string; imageNo: string; cardNo: string; reason: string }[];
  finishedAt: number | null;
}

/** 执行结果统计 */
export interface MergeResult {
  written: number;
  merged: number;
  added: number;
  conflictsResolved: number;
  thumbsRepaired: number;
  blankFilled: number;
}
