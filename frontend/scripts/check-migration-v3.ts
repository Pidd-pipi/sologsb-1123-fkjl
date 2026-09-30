// v2 → v3 升级：补成果快照但不重算实测值；修复断链缩略图；新字段缺省
import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';

const DB_NAME = 'gbdronemap';
const now = Date.now();

interface V2Mission { id: string; missionNo: string; cameraModel: string; sensorWidth: number; sensorHeight: number; focalLength: number; pixelSize: number; [k: string]: unknown }
interface V2Line { id: string; missionId: string; lineNo: number; overlapForward: number; overlapSide: number; gsd: number; spacing: number; photoInterval: number; updatedAt: number }
interface V2Asset { id: string; missionId: string; imageNo: string; lng: number; lat: number; altitude: number; gsd: number; overlap: number; tiltAngle: number; shotAt: number; quality: string; folder: string }

class V2DB extends Dexie {
  missions!: Table<V2Mission, string>;
  waypoints!: Table;
  lines!: Table<V2Line, string>;
  assets!: Table<V2Asset, string>;
  thumbs!: Table<{ id: string; missionId: string; dataUrl: string }, string>;
  presets!: Table;
  constructor() {
    super(DB_NAME);
    this.version(2).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
      waypoints: 'id, missionId, seq, action, altitude',
      lines: 'id, missionId, lineNo, updatedAt',
      assets: 'id, missionId, imageNo, quality, shotAt',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
    });
  }
}

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}`); }
}

const v2 = new V2DB();
const mission: V2Mission = {
  id: 'm1', missionNo: 'DM-OLD-1', cameraModel: 'OLD-CAM', sensorWidth: 13.2, sensorHeight: 8.8,
  focalLength: 8.8, pixelSize: 2.4,
};
const line: V2Line = { id: 'l1', missionId: 'm1', lineNo: 1, overlapForward: 70, overlapSide: 65, gsd: 2.0, spacing: 50, photoInterval: 30, updatedAt: now - 1000 };
const asset: V2Asset = {
  id: 'a1', missionId: 'm1', imageNo: 'IMG_9001', lng: 116.1, lat: 39.1, altitude: 100,
  gsd: 4.66, overlap: 61, tiltAngle: 9, shotAt: now - 500, quality: '模糊', folder: '/old',
};
await v2.missions.put(mission);
await v2.lines.put(line);
await v2.assets.put(asset);
// a1 无缩略图（断链）；a2 有
await v2.assets.put({ ...asset, id: 'a2', imageNo: 'IMG_9002' });
await v2.thumbs.put({ id: 'a2', missionId: 'm1', dataUrl: 'data:image/svg+xml,old' });
v2.close();

// 用旧相机参数“后来改过”的场景：升级后若按当前 mission 重算，GSD 会变；
// 迁移必须冻结实测 4.66，且快照记录的是升级时的任务参数
const { db } = await import('../src/utils/db');
assert(db.verno >= 3, `结构升级到 v3（实际 verno=${db.verno}）`);

const a1 = await db.assets.get('a1');
const a2 = await db.assets.get('a2');
assert(a1?.gsd === 4.66 && a1.overlap === 61, '已收实测 GSD/重叠率原样保留，未用相机或航线参数重算');
assert(a1?.snapshotFilled === true && a1.snapshot?.source === 'migration-v3', '旧条目补齐成果快照');
assert(a1?.snapshot?.measured.gsd === 4.66 && a1.snapshot.measured.overlap === 61, '快照内冻结的是已收实测值');
assert(a1?.snapshot?.line?.gsd === 2.0 && a1.snapshot.mission.focalLength === 8.8, '快照记录升级时的航线/相机参数（仅溯源）');
assert(a1?.qualityConfirmed === true, '旧条目已打过质量标 → 视为已确认质量');
assert(Array.isArray(a1?.sourceCardNos) && a1?.mergeBatchId === '', '新增卡片溯源/批次字段缺省正确');
const t1 = await db.thumbs.get('a1');
const t2 = await db.thumbs.get('a2');
assert(Boolean(t1?.dataUrl), '断链缩略图 a1 已补建');
assert(t2?.dataUrl === 'data:image/svg+xml,old', '已有缩略图 a2 原样保留不重建');
assert((await db.mergeBatches.count()) === 0, 'mergeBatches 表就绪且为空');

// 升级后再改任务相机参数，已收条目快照不受影响
await db.missions.update('m1', { focalLength: 24, pixelSize: 5 });
const a1Again = await db.assets.get('a1');
assert(a1Again?.snapshot?.mission.focalLength === 8.8 && a1Again.gsd === 4.66, '后来修改相机参数不改写已收实测值与快照');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
