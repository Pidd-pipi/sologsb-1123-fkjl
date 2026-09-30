import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { newId } from './id';
import {
  applyMergePlan,
  buildMergePlan,
  ensureAssetSnapshot,
  mergeKey,
  parseCardManifest,
  planToAssets,
  planWritable,
  resolveConflict,
} from './assetMerge';
import { MERGE_GSD_TOLERANCE, type ImageAsset } from '../types/imageasset';
import type { CardAsset, CardManifest, MergePlan } from '../types/merge';
import type { Mission } from '../types/mission';

function makeAsset(over: Partial<ImageAsset> = {}): ImageAsset {
  return {
    id: newId('asset'),
    missionId: 'm1',
    imageNo: 'IMG_1001',
    lng: 116.39,
    lat: 39.9,
    altitude: 120,
    gsd: 3.22,
    overlap: 75,
    tiltAngle: 2,
    shotAt: 1000,
    quality: '合格',
    folder: '/DM-2024-018/100MEDIA',
    ...over,
  };
}

function manifest(label: string, assets: CardAsset[], missionNo = 'DM-2024-018'): CardManifest {
  return { cardLabel: label, missionNo, assets };
}

const mission: Mission = {
  id: 'm1',
  missionNo: 'DM-2024-018',
  name: '测试任务',
  areaName: '测区',
  areaPolygon: [],
  purpose: '正射',
  droneModel: 'Mavic 3E',
  cameraModel: 'X',
  sensorWidth: 17.3,
  sensorHeight: 13,
  focalLength: 12.29,
  pixelSize: 3.3,
  flightDate: '2024-09-12',
  pilot: '测试',
  status: '已飞行',
  createdAt: 1,
};

describe('buildMergePlan · 认片身份', () => {
  it('按任务编号+片号认作同一张，卡片临时编号不当身份', () => {
    const base = [makeAsset({ id: 'base_id', imageNo: 'IMG_1001' })];
    const cardA = manifest('A', [{ tempId: 'TEMP_AAA', imageNo: 'IMG_1001', gsd: 3.3 }]);
    const cardB = manifest('B', [{ tempId: 'TEMP_BBB', imageNo: 'IMG_1001', gsd: 3.31 }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base, baseThumbs: {}, cardA, cardB });
    expect(plan.items.length).toBe(1);
    expect(plan.items[0].inBase).toBe(true);
    expect(plan.items[0].inA).toBe(true);
    expect(plan.items[0].inB).toBe(true);
    expect(plan.stats.matched).toBe(1);

    // 落库时复用编目已有 id，临时编号绝不写入
    const existingByKey = new Map([[mergeKey('DM-2024-018', 'IMG_1001'), base[0]]]);
    const snap = { sensorWidth: 17.3, sensorHeight: 13, focalLength: 12.29, pixelSize: 3.3, source: 'collection' as const, at: 1 };
    const { assets } = planToAssets(plan, 'm1', snap, existingByKey);
    expect(assets[0].id).toBe('base_id');
    expect(assets[0].id).not.toContain('TEMP');
  });

  it('不同片号即使临时编号相同也不是同一张', () => {
    const cardA = manifest('A', [{ tempId: 'TEMP_1', imageNo: 'IMG_1001' }]);
    const cardB = manifest('B', [{ tempId: 'TEMP_1', imageNo: 'IMG_1002' }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB });
    expect(plan.items.length).toBe(2);
  });
});

describe('buildMergePlan · 空白补齐', () => {
  it('编目空白字段从另一张卡补', () => {
    const cardA = manifest('A', [
      { tempId: 'A1', imageNo: 'IMG_1001', lng: 1, lat: 2, altitude: 120, gsd: 3.2, overlap: 70, quality: '合格' },
    ]);
    const cardB = manifest('B', [
      { tempId: 'B1', imageNo: 'IMG_1001', lng: null, lat: null, altitude: null, overlap: null, folder: '/fromB' },
    ]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB });
    const item = plan.items[0];
    expect(item.values.lng).toBe(1);
    expect(item.values.lat).toBe(2);
    expect(item.values.altitude).toBe(120);
    expect(item.values.overlap).toBe(70);
    expect(item.values.folder).toBe('/fromB');
    const filledFields = item.fills.map((f) => f.field);
    expect(filledFields).toContain('lng');
    expect(filledFields).toContain('lat');
    expect(filledFields).toContain('folder');
    expect(item.fills.find((f) => f.field === 'folder')?.from).toBe('B');
  });
});

describe('buildMergePlan · 保留实测/确认值', () => {
  it('已确认质量、实测重叠率、实测 GSD、缩略图保留不被覆盖', () => {
    const base = [
      makeAsset({
        id: 'b1',
        imageNo: 'IMG_1001',
        quality: '合格',
        overlap: 80,
        gsd: 3.22,
      }),
    ];
    const baseThumbs = { b1: 'base-thumb-data' };
    const cardA = manifest('A', [
      { tempId: 'A1', imageNo: 'IMG_1001', quality: '模糊', overlap: 60, gsd: 3.3 },
    ]);
    const cardB = manifest('B', [{ tempId: 'B1', imageNo: 'IMG_1001', gsd: 3.31 }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base, baseThumbs, cardA, cardB });
    const item = plan.items[0];
    expect(item.values.quality).toBe('合格');
    expect(item.values.overlap).toBe(80);
    expect(item.values.gsd).toBe(3.22);
    expect(item.thumb).toBe('base-thumb-data');
    expect(item.thumbFrom).toBe('base');
    expect(item.retained).toContain('quality');
    expect(item.retained).toContain('overlap');
    expect(item.retained).toContain('gsd');
    expect(item.retained).toContain('thumb');
  });

  it('编目缩略图断链时从卡片补，杜绝断链', () => {
    const base = [makeAsset({ id: 'b1', imageNo: 'IMG_1001' })];
    const cardA = manifest('A', [{ tempId: 'A1', imageNo: 'IMG_1001', thumb: 'A-thumb' }]);
    const cardB = manifest('B', [{ tempId: 'B1', imageNo: 'IMG_1001', thumb: null }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base, baseThumbs: {}, cardA, cardB });
    expect(plan.items[0].thumb).toBe('A-thumb');
    expect(plan.items[0].thumbFrom).toBe('A');
  });
});

describe('buildMergePlan · GSD 冲突区', () => {
  it('两卡实测 GSD 相差超过容差进入冲突区，未选定不可写入', () => {
    const cardA = manifest('A', [{ tempId: 'A1', imageNo: 'IMG_1001', gsd: 3.22 }]);
    const cardB = manifest('B', [{ tempId: 'B1', imageNo: 'IMG_1001', gsd: 3.6 }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB });
    expect(plan.conflicts.length).toBe(1);
    expect(plan.conflicts[0].pick).toBeUndefined();
    expect(planWritable(plan)).toBe(false);
    expect(plan.stats.conflictCount).toBe(1);
  });

  it('容差内不进入冲突区', () => {
    const cardA = manifest('A', [{ tempId: 'A1', imageNo: 'IMG_1001', gsd: 3.22 }]);
    const cardB = manifest('B', [{ tempId: 'B1', imageNo: 'IMG_1001', gsd: 3.3 }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB, tolerance: MERGE_GSD_TOLERANCE });
    expect(plan.conflicts.length).toBe(0);
    expect(planWritable(plan)).toBe(true);
  });

  it('人工选定后才写入对应 GSD', () => {
    const cardA = manifest('A', [{ tempId: 'A1', imageNo: 'IMG_1001', gsd: 3.22 }]);
    const cardB = manifest('B', [{ tempId: 'B1', imageNo: 'IMG_1001', gsd: 3.6 }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB });
    const key = plan.conflicts[0].key;
    resolveConflict(plan, key, 'B');
    expect(plan.conflicts[0].pick).toBe('B');
    expect(plan.items[0].values.gsd).toBe(3.6);
    expect(planWritable(plan)).toBe(true);
  });
});

describe('planToAssets · 幂等与缩略图', () => {
  it('新条目用确定性 id，重复落库不产生重复；缩略图缺失则生成占位', () => {
    const cardA = manifest('A', [{ tempId: 'A1', imageNo: 'IMG_1001', gsd: 3.2 }]);
    const cardB = manifest('B', [{ tempId: 'B1', imageNo: 'IMG_1002', gsd: 3.3 }]);
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB });
    const snap = { sensorWidth: 17.3, sensorHeight: 13, focalLength: 12.29, pixelSize: 3.3, source: 'collection' as const, at: 1 };
    const first = planToAssets(plan, 'm1', snap, new Map());
    const second = planToAssets(plan, 'm1', snap, new Map());
    expect(first.assets.map((a) => a.id)).toEqual(second.assets.map((a) => a.id));
    expect(first.assets.length).toBe(2);
    // 每条都有缩略图，杜绝断链
    expect(first.thumbs.every((t) => t.dataUrl.length > 0)).toBe(true);
    expect(first.thumbs.length).toBe(2);
  });
});

describe('parseCardManifest', () => {
  it('解析 JSON 对象清单', () => {
    const text = JSON.stringify({ missionNo: 'DM-2024-018', cardLabel: 'A 卡', assets: [{ imageNo: 'IMG_1001', gsd: 3.2 }] });
    const res = parseCardManifest(text);
    expect(res.ok).toBe(true);
    expect(res.manifest?.missionNo).toBe('DM-2024-018');
    expect(res.manifest?.assets[0].imageNo).toBe('IMG_1001');
  });

  it('解析 JSON 数组清单', () => {
    const res = parseCardManifest(JSON.stringify([{ imageNo: 'IMG_1001' }]));
    expect(res.ok).toBe(true);
    expect(res.manifest?.assets.length).toBe(1);
  });

  it('解析 CSV 清单', () => {
    const csv = 'missionNo,imageNo,gsd,quality\nDM-2024-018,IMG_1001,3.2,合格\nDM-2024-018,IMG_1002,3.3,模糊';
    const res = parseCardManifest(csv);
    expect(res.ok).toBe(true);
    expect(res.manifest?.assets.length).toBe(2);
    expect(res.manifest?.missionNo).toBe('DM-2024-018');
    expect(res.manifest?.assets[1].quality).toBe('模糊');
  });
});

describe('ensureAssetSnapshot · 旧数据升级', () => {
  it('为缺快照条目补录 legacy 快照，且不改写实测 gsd/overlap', () => {
    const legacy = makeAsset({ id: 'x', gsd: 3.22, overlap: 75 });
    delete (legacy as Partial<ImageAsset>).snapshot;
    const out = ensureAssetSnapshot(legacy, mission);
    expect(out.snapshot?.source).toBe('legacy');
    expect(out.snapshot?.focalLength).toBe(12.29);
    expect(out.gsd).toBe(3.22);
    expect(out.overlap).toBe(75);
  });

  it('已有快照不覆盖', () => {
    const withSnap = makeAsset({ snapshot: { sensorWidth: 1, sensorHeight: 2, focalLength: 3, pixelSize: 4, source: 'collection', at: 9 } });
    const out = ensureAssetSnapshot(withSnap, mission);
    expect(out.snapshot?.source).toBe('collection');
    expect(out.snapshot?.at).toBe(9);
  });
});

describe('applyMergePlan · 写入 / 回滚 / 续作', () => {
  beforeEach(async () => {
    await db.assets.clear();
    await db.thumbs.clear();
    await db.mergeRuns.clear();
    await db.missions.clear();
    await db.missions.put(mission);
  });

  function seedBase() {
    const base = [makeAsset({ id: 'b1', imageNo: 'IMG_1001', gsd: 3.22, overlap: 75, quality: '合格' })];
    return base;
  }

  function planFor(base: ImageAsset[]): MergePlan {
    const cardA = manifest('A', [
      { tempId: 'A1', imageNo: 'IMG_1001', gsd: 3.3, lng: 1, lat: 2 },
      { tempId: 'A2', imageNo: 'IMG_1002', gsd: 3.1 },
    ]);
    const cardB = manifest('B', [
      { tempId: 'B1', imageNo: 'IMG_1001', gsd: 3.31 },
      { tempId: 'B2', imageNo: 'IMG_1003', gsd: 3.0 },
    ]);
    return buildMergePlan({ missionNo: 'DM-2024-018', base, baseThumbs: {}, cardA, cardB });
  }

  it('写入编目且幂等：重复写入不产生重复条目', async () => {
    const base = seedBase();
    await db.assets.bulkPut(base);
    const plan = planFor(base);
    await applyMergePlan(plan, 'm1');
    const after1 = await db.assets.where('missionId').equals('m1').toArray();
    expect(after1.length).toBe(3); // IMG_1001/1002/1003
    const thumbs1 = await db.thumbs.where('missionId').equals('m1').toArray();
    expect(thumbs1.length).toBe(3);

    // 再次写入（断点续作/重试）幂等
    await applyMergePlan(plan, 'm1');
    const after2 = await db.assets.where('missionId').equals('m1').toArray();
    expect(after2.length).toBe(3);
    const ids = after2.map((a) => a.id).sort();
    expect(new Set(ids).size).toBe(3);
  });

  it('失败后恢复原编目：条目与缩略图回到合并前', async () => {
    const base = seedBase();
    await db.assets.bulkPut(base);
    await db.thumbs.bulkPut([{ id: 'b1', missionId: 'm1', dataUrl: 'thumb-before' }]);
    const plan = planFor(base);
    await expect(applyMergePlan(plan, 'm1', { failAfterBatch: 0 })).rejects.toThrow();

    const restored = await db.assets.where('missionId').equals('m1').toArray();
    expect(restored.length).toBe(1);
    expect(restored[0].id).toBe('b1');
    const restoredThumbs = await db.thumbs.where('missionId').equals('m1').toArray();
    expect(restoredThumbs.length).toBe(1);
    expect(restoredThumbs[0].dataUrl).toBe('thumb-before');
  });

  it('恢复后重试从未完成批次继续并完成合并', async () => {
    const base = seedBase();
    await db.assets.bulkPut(base);
    const plan = planFor(base);
    await expect(applyMergePlan(plan, 'm1', { failAfterBatch: 0 })).rejects.toThrow();
    // 重试（不注入失败）
    await applyMergePlan(plan, 'm1');
    const after = await db.assets.where('missionId').equals('m1').toArray();
    expect(after.length).toBe(3);
    // 保留了编目已确认质量
    const kept = after.find((a) => a.imageNo === 'IMG_1001');
    expect(kept?.quality).toBe('合格');
    expect(kept?.overlap).toBe(75);
  });

  it('多批次下失败恢复原编目，重试幂等不重复', async () => {
    // 生成 45 个片号（超过单批 40，触发多批次）
    const assets45: CardAsset[] = Array.from({ length: 45 }, (_, i) => ({
      tempId: `TEMP_${i}`,
      imageNo: `IMG_${2001 + i}`,
      gsd: 3.2 + i * 0.001,
      overlap: 70,
      quality: '合格' as const,
    }));
    const cardA = manifest('A', assets45);
    const cardB = manifest('B', assets45.map((a) => ({ ...a, tempId: `T2_${a.imageNo}` })));
    const plan = buildMergePlan({ missionNo: 'DM-2024-018', base: [], baseThumbs: {}, cardA, cardB });
    expect(plan.items.length).toBe(45);

    // 第 0 批提交后第 1 批失败 → 恢复原编目（空）
    await expect(applyMergePlan(plan, 'm1', { failAfterBatch: 1 })).rejects.toThrow();
    const restored = await db.assets.where('missionId').equals('m1').count();
    expect(restored).toBe(0);

    // 重试完成：45 条，无重复
    await applyMergePlan(plan, 'm1');
    const after = await db.assets.where('missionId').equals('m1').toArray();
    expect(after.length).toBe(45);
    expect(new Set(after.map((a) => a.id)).size).toBe(45);
    // 缩略图齐全，无断链
    const thumbs = await db.thumbs.where('missionId').equals('m1').toArray();
    expect(thumbs.length).toBe(45);
    expect(thumbs.every((t) => t.dataUrl.length > 0)).toBe(true);
  });
});
