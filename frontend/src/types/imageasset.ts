import type { Mission } from './mission';

/** 成果影像质量 */
export type ImageQuality = '合格' | '模糊' | '过曝';

export const IMAGE_QUALITIES: ImageQuality[] = ['合格', '模糊', '过曝'];

/**
 * 成果快照：收测时刻的相机参数记录，仅用于溯源。
 * 升级补录的快照 source 为 'legacy'，不得据此改写已收实测值（gsd / overlap）。
 */
export interface AssetSnapshot {
  sensorWidth: number;
  sensorHeight: number;
  focalLength: number;
  pixelSize: number;
  /** collection=收测时记录；legacy=旧数据升级补录 */
  source: 'collection' | 'legacy';
  at: number;
}

/** 成果影像条目 */
export interface ImageAsset {
  id: string;
  missionId: string;
  /** 影像片号 */
  imageNo: string;
  lng: number;
  lat: number;
  /** 航高 m */
  altitude: number;
  /** 实际 GSD cm/px（实测值，合并/升级均不得用参数回算值覆盖） */
  gsd: number;
  /** 实际重叠 %（实测值，合并保留） */
  overlap: number;
  /** 倾角 ° */
  tiltAngle: number;
  shotAt: number;
  quality: ImageQuality;
  /** 归档目录 */
  folder: string;
  /** 收测相机参数快照（旧数据升级时补录，不参与实测值改写） */
  snapshot?: AssetSnapshot;
}

export type ImageAssetDraft = Omit<ImageAsset, 'id'>;

/** 两卡实测 GSD 相对差异容差：|a-b|/max(|a|,|b|) 超过该值进入冲突区 */
export const MERGE_GSD_TOLERANCE = 0.05;

/** 判断字段是否为空白（null/undefined/空串/NaN） */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

/** 用当前任务相机参数生成一份成果快照 */
export function snapshotFromMission(mission: Mission, source: AssetSnapshot['source'], at = Date.now()): AssetSnapshot {
  return {
    sensorWidth: mission.sensorWidth,
    sensorHeight: mission.sensorHeight,
    focalLength: mission.focalLength,
    pixelSize: mission.pixelSize,
    source,
    at,
  };
}

/** 缩略图（单独建表存放 dataUrl） */
export interface AssetThumb {
  /** 与影像条目 id 一一对应 */
  id: string;
  missionId: string;
  dataUrl: string;
}

/** 本地生成缩略图（不依赖网络） */
export function makeThumbDataUrl(imageNo: string, quality: ImageQuality, lng: number, lat: number): string {
  const tone = quality === '合格' ? '#2f6f4f' : quality === '模糊' ? '#8a6d1f' : '#8a3b2f';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">
  <rect width="240" height="160" fill="${tone}"/>
  <path d="M0 120 L60 96 L120 126 L180 84 L240 110 L240 160 L0 160 Z" fill="#20303a" opacity="0.55"/>
  <circle cx="196" cy="34" r="16" fill="#f2d98a" opacity="0.85"/>
  <text x="10" y="26" font-size="15" fill="#ffffff" font-family="sans-serif">${imageNo}</text>
  <text x="10" y="48" font-size="12" fill="#e6f0ff" font-family="sans-serif">${quality} · ${lng.toFixed(5)}, ${lat.toFixed(5)}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
