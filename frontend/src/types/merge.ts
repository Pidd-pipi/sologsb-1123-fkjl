import type { AssetThumb, ImageAsset, ImageQuality } from './imageasset';

/**
 * 卡片中的单条成果。
 * 注意：tempId 只是卡片内的临时编号，**不是**编目身份；合并身份是 (任务编号, 片号)。
 */
export interface CardAsset {
  /** 卡片临时编号，仅用于卡片内引用，绝不作为编目身份 */
  tempId?: string;
  imageNo: string;
  lng?: number | null;
  lat?: number | null;
  altitude?: number | null;
  gsd?: number | null;
  overlap?: number | null;
  tiltAngle?: number | null;
  shotAt?: number | null;
  quality?: ImageQuality | '' | null;
  folder?: string | null;
  /** 缩略图 dataUrl；为空表示该卡缩略图断链/缺失 */
  thumb?: string | null;
}

/** 一张外业卡的清单 */
export interface CardManifest {
  cardLabel: string;
  missionNo: string;
  assets: CardAsset[];
}

export type MergeField =
  | 'lng'
  | 'lat'
  | 'altitude'
  | 'gsd'
  | 'overlap'
  | 'tiltAngle'
  | 'shotAt'
  | 'quality'
  | 'folder'
  | 'thumb';

export type MergeSource = 'base' | 'A' | 'B';

/** 两卡实测 GSD 冲突（超过容差，需人工选定后才写入） */
export interface GsdConflict {
  key: string;
  imageNo: string;
  base?: number;
  a?: number;
  b?: number;
  /** 两卡相对差异 |a-b|/max(|a|,|b|) */
  delta: number;
  tolerance: number;
  /** 人工选定的来源；未选时为 undefined，不可写入 */
  pick?: MergeSource;
}

/** 一次空白字段补齐记录 */
export interface FieldFill {
  field: MergeField;
  from: MergeSource;
}

/** 单个 (任务编号, 片号) 的合并结果 */
export interface MergeItem {
  key: string;
  missionNo: string;
  imageNo: string;
  inBase: boolean;
  inA: boolean;
  inB: boolean;
  /** 合并后的标量字段值（已完成空白补齐与保留） */
  values: Partial<Record<MergeField, number | string>>;
  thumb?: string;
  thumbFrom?: MergeSource;
  /** 空白补齐记录 */
  fills: FieldFill[];
  /** 保留字段（已有确认质量 / 实测重叠 / 实测 GSD / 缩略图） */
  retained: MergeField[];
  conflict?: GsdConflict;
}

/** 两卡合并方案（纯数据，可序列化、可落库） */
export interface MergePlan {
  missionNo: string;
  tolerance: number;
  items: MergeItem[];
  conflicts: GsdConflict[];
  stats: {
    total: number;
    /** 同时存在于两方及以上 */
    matched: number;
    onlyA: number;
    onlyB: number;
    fillCount: number;
    retainedCount: number;
    conflictCount: number;
  };
}

export type MergeRunStatus = 'applying' | 'done' | 'failed' | 'rolled_back';

/** 一次合并写入批次运行记录（用于失败恢复与断点续作） */
export interface MergeRun {
  id: string;
  missionId: string;
  missionNo: string;
  status: MergeRunStatus;
  tolerance: number;
  plan: MergePlan;
  /** 已完成写入的批次序号（从 0 起） */
  doneBatches: number[];
  totalBatches: number;
  /** 回滚用：本任务被改写前的原始条目 */
  beforeAssets: ImageAsset[];
  /** 回滚用：本任务被改写前的缩略图 */
  beforeThumbs: AssetThumb[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}
