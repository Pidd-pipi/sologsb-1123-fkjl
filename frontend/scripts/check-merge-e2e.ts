// 端到端：首次写入中断 → 整库恢复原编目 → 从断点重试成功（fake-indexeddb）
import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import { useMergeStore } from '../src/stores/mergeStore';
import { useAssetStore } from '../src/stores/assetStore';
import { parseCardManifest } from '../src/utils/cardMerge';
import { buildAssetSnapshot } from '../src/utils/cardMerge';
import type { Mission } from '../src/types/mission';
import type { ImageAsset } from '../src/types/imageasset';

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}`); }
}

const now = Date.now();
const mission: Mission = {
  id: 'm1', missionNo: 'DM-2024-018', name: 't', areaName: 'a', areaPolygon: [], purpose: '正射',
  droneModel: 'D', cameraModel: 'C', sensorWidth: 17.3, sensorHeight: 13, focalLength: 12.29, pixelSize: 3.3,
  flightDate: '2024-09-12', pilot: 'p', status: '已飞行', createdAt: now,
};

const rows: string[] = ['任务编号\t片号\t卡片临时编号\t经度\t纬度\t航高\t实测GSD\t实测重叠率\t质量'];
for (let i = 1; i <= 10; i += 1) {
  rows.push(`DM-2024-018\tIMG_20${String(i).padStart(2, '0')}\tTMP-A-${i}\t116.4\t39.9\t120\t3.2${i % 9}\t7${4 + (i % 5)}\t合格`);
}
const cardA = parseCardManifest(rows.join('\n'), 'A');

async function snapshotAssets() {
  const list = await db.assets.toArray();
  return list.map((a) => ({ id: a.id, gsd: a.gsd, overlap: a.overlap })).sort((x, y) => x.id.localeCompare(y.id));
}

await db.missions.put(mission);

// 原编目：1 张已确认质量「模糊」的已有影像（IMG_2001），其缩略图故意缺失（断链）
const existing: ImageAsset = {
  id: 'orig-1', missionId: 'm1', imageNo: 'IMG_2001', cardNo: '老卡', sourceCardNos: ['老卡'],
  lng: 116.4, lat: 39.9, altitude: 120, gsd: 3.55, overlap: 88, tiltAngle: 2, shotAt: now,
  quality: '模糊', qualityConfirmed: true, folder: '/old', mergeBatchId: '', snapshotFilled: true,
  snapshot: buildAssetSnapshot({ gsd: 3.55, overlap: 88, altitude: 120, tiltAngle: 2, lng: 116.4, lat: 39.9, shotAt: now }, mission, null, 'migration-v3'),
};
await db.assets.put(existing);
// 注意：不放 thumbs → 断链
const before = await snapshotAssets();

const mergeStore = useMergeStore.getState();
const assetStore = useAssetStore.getState();

const batch = await mergeStore.createBatch({ cardA, cardB: null, tolerance: 0.3, simulateFailure: true });
assert(batch.plan.length === 10, `计划 10 个身份（实际 ${batch.plan.length}）`);
assert(batch.plan.find((p) => p.imageNo === 'IMG_2001')!.repairThumb === true, '已有断链缩略图被标记补建');

// 首跑：chunkSize=6，第一块（6 张）写完后模拟中断
const first = await mergeStore.runBatch(batch.id);
assert(first.ok === false, '首次执行报告失败');
assert(first.batch.status === 'failed' && first.batch.nextChunk === 1, '失败后记录断点：第 1 块（6 张）曾完成');
assert(Boolean(first.batch.backup), '失败批次保留原编目备份');

// 原编目已整体恢复：资产回到合并前
const afterFailure = await snapshotAssets();
assert(JSON.stringify(afterFailure) === JSON.stringify(before), '失败后已先恢复原编目（库内容与合并前一致）');
const thumbStillMissing = await db.thumbs.get('orig-1');
assert(thumbStillMissing === undefined, '回滚后断链缩略图仍为原状（未被部分写入污染）');

// 重试：simulateFailure 仅首跑生效；原已确认质量的影像最终仍保留「模糊」
const second = await mergeStore.runBatch(first.batch.id);
assert(second.ok === true, '断点重试成功');
assert(second.stats?.written === 10 && second.stats?.added === 9 && second.stats?.merged === 1, `统计正确（${JSON.stringify(second.stats)}）`);
assert(second.stats?.thumbsRepaired === 10, '10 张缩略图（含 1 张断链修复）写入');
assert(second.batch.backup === null && second.batch.status === 'done', '成功后清空备份、批次完成');

const finalList = await db.assets.orderBy('imageNo').toArray();
assert(finalList.length === 10, '编目最终为 10 张（重试不产生重复/丢失）');
const kept = finalList.find((a) => a.imageNo === 'IMG_2001')!;
assert(kept.id === 'orig-1' && kept.quality === '模糊' && kept.qualityConfirmed === true, '已确认质量「模糊」重试后仍保留');
assert(kept.gsd === 3.55 && kept.overlap === 88, '已收实测 GSD/重叠率保留，未被卡片覆盖');
assert(kept.snapshot?.measured.gsd === 3.55 && kept.snapshot.source === 'migration-v3', '旧快照不被重算改写');
const repairedThumb = await db.thumbs.get('orig-1');
assert(Boolean(repairedThumb?.dataUrl), '断链缩略图已补建');

// store 重新加载后看到同一结果
await assetStore.load();
assert(useAssetStore.getState().items.length === 10, '成果页 store 重载后为同一批 10 张');
assert(Boolean(useAssetStore.getState().thumbs['orig-1']), 'store 缩略图映射含补建项');

// 重试具备幂等性：done 批次再次执行被拒绝
const third = await mergeStore.runBatch(second.batch.id);
assert(third.ok === false, '已完成批次不可重复执行');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
