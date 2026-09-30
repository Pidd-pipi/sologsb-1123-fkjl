/** 成果影像质量 */
export type ImageQuality = '合格' | '模糊' | '过曝';

export const IMAGE_QUALITIES: ImageQuality[] = ['合格', '模糊', '过曝'];

/** 成果快照来源：旧数据升级 / 两卡合并 / 初始示范 */
export type AssetSnapshotSource = 'migration-v3' | 'card-merge' | 'seed';

/**
 * 成果快照：影像入藏时冻结的任务相机、航线参数与实测值。
 * 之后任务相机或航线参数被修改，也不拿新参数重算快照里的已收实测值。
 */
export interface AssetSnapshot {
  filledAt: number;
  source: AssetSnapshotSource;
  /** 入藏时的相机参数（仅作溯源，不参与回算） */
  mission: {
    missionNo: string;
    cameraModel: string;
    sensorWidth: number;
    sensorHeight: number;
    focalLength: number;
    pixelSize: number;
  };
  /** 入藏时的航线参数；任务没有航线参数时为 null */
  line: {
    lineNo: number;
    overlapForward: number;
    overlapSide: number;
    gsd: number;
    spacing: number;
    photoInterval: number;
    updatedAt: number;
  } | null;
  /** 入藏时冻结的实测值 */
  measured: {
    gsd: number;
    overlap: number;
    altitude: number;
    tiltAngle: number;
    lng: number;
    lat: number;
    shotAt: number;
  };
}

/** 成果影像条目 */
export interface ImageAsset {
  id: string;
  missionId: string;
  /** 影像片号（与任务编号共同构成同一张影像的身份） */
  imageNo: string;
  /** 外业卡片临时编号，仅用于溯源，不能当作影像身份 */
  cardNo: string;
  /** 该影像来自哪些卡片临时编号（合并后去重留存） */
  sourceCardNos: string[];
  lng: number;
  lat: number;
  /** 航高 m */
  altitude: number;
  /** 实际 GSD cm/px */
  gsd: number;
  /** 实际重叠 % */
  overlap: number;
  /** 倾角 ° */
  tiltAngle: number;
  shotAt: number;
  quality: ImageQuality;
  /** 质量是否已被内业确认；已确认质量在两卡合并时保留 */
  qualityConfirmed: boolean;
  /** 归档目录 */
  folder: string;
  /** 最近一次写入该条目的合并批次 id */
  mergeBatchId: string;
  /** 是否已补齐成果快照 */
  snapshotFilled: boolean;
  snapshot?: AssetSnapshot;
}

export type ImageAssetDraft = Omit<
  ImageAsset,
  'id' | 'cardNo' | 'sourceCardNos' | 'qualityConfirmed' | 'mergeBatchId' | 'snapshotFilled' | 'snapshot'
> &
  Partial<Pick<ImageAsset, 'cardNo' | 'sourceCardNos' | 'qualityConfirmed' | 'mergeBatchId' | 'snapshotFilled' | 'snapshot'>>;

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
