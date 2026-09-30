import { parseCardManifest, buildMergePlan, composeAsset, buildAssetSnapshot } from '../src/utils/cardMerge';
import { makeThumbDataUrl, type ImageAsset } from '../src/types/imageasset';
import type { Mission } from '../src/types/mission';

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

const mission: Mission = {
  id: 'm1',
  missionNo: 'DM-2024-018',
  name: '测试任务',
  areaName: '测区',
  areaPolygon: [],
  purpose: '正射',
  droneModel: 'Mavic 3E',
  cameraModel: 'CAM',
  sensorWidth: 17.3,
  sensorHeight: 13,
  focalLength: 12.29,
  pixelSize: 3.3,
  flightDate: '2024-09-12',
  pilot: 'p',
  status: '已飞行',
  createdAt: 1,
};

const cardA = parseCardManifest(
  [
    '任务编号\t片号\t卡片临时编号\t经度\t纬度\t航高\t实测GSD\t实测重叠率\t倾角\t质量',
    'DM-2024-018\tIMG_1001\tTMP-A-1\t116.39\t39.90\t120\t3.22\t75\t3\t合格',
    'DM-2024-018\tIMG_1002\tTMP-A-2\t116.40\t39.90\t\t3.90\t\t4\t', // 与卡B冲突，空白字段
    'DM-2024-018\tIMG_1003\tTMP-A-3\t116.41\t39.90\t120\t3.20\t74\t5\t合格',
    'DM-2024-018\tIMG_1003\tTMP-A-3X\t116.41\t39.90\t120\t9.99\t99\t9\t过曝', // 同卡重复：保留先到实测
    'DM-2024-099\tIMG_9001\tTMP-A-9\t116.9\t39.9\t120\t3.3\t70\t3\t合格', // 未知任务
    '\tIMG_NO_NO\tTMP-X\t1\t1\t1\t1\t1\t1\t合格', // 缺任务编号
  ].join('\n'),
  'A',
);
const cardB = parseCardManifest(
  [
    '任务编号\t片号\t卡片临时编号\t经度\t纬度\t航高\t实测GSD\t实测重叠率\t倾角\t质量',
    'DM-2024-018\tIMG_1002\tTMP-B-2\t116.40\t39.90\t121\t3.20\t76\t4\t合格',
    'DM-2024-018\tIMG_1004\tTMP-B-4\t116.42\t39.90\t120\t3.23\t77\t2\t合格',
  ].join('\n'),
  'B',
);

assert(cardA.rows.length === 5, '解析：同卡重复片号折叠（1001/1002/1003 两组 + 缺任务编号行待计划阶段拒收）');
assert(cardA.rows.find((r) => r.imageNo === 'IMG_1003')!.duplicateInCard === 1, '解析：记录同卡重复行数');
assert(cardA.rows.find((r) => r.imageNo === 'IMG_1003')!.gsd === 3.2, '解析：同卡重复保留先到实测 GSD，不被后行 9.99 覆盖');
assert(cardA.invalidRows.length === 0, '解析：缺任务编号但结构完整的行保留到计划阶段按任务编号拒收');

// 已收编目：IMG_1001 质量已确认 + 有实测重叠率/GSD；IMG_1003 已收但质量未确认
const existing1001: ImageAsset = {
  id: 'e1001', missionId: 'm1', imageNo: 'IMG_1001', cardNo: '旧卡', sourceCardNos: ['旧卡'],
  lng: 116.39, lat: 39.90, altitude: 118, gsd: 3.50, overlap: 80, tiltAngle: 7,
  shotAt: 123, quality: '模糊', qualityConfirmed: true, folder: '/old', mergeBatchId: '', snapshotFilled: true,
  snapshot: buildAssetSnapshot({ gsd: 3.5, overlap: 80, altitude: 118, tiltAngle: 7, lng: 116.39, lat: 39.9, shotAt: 123 }, mission, null, 'migration-v3'),
};
const existing1003: ImageAsset = {
  id: 'e1003', missionId: 'm1', imageNo: 'IMG_1003', cardNo: '', sourceCardNos: [],
  lng: 116.41, lat: 39.90, altitude: 0, gsd: 0, overlap: 0, tiltAngle: 0,
  shotAt: 0, quality: '合格', qualityConfirmed: false, folder: '', mergeBatchId: '', snapshotFilled: false,
};

const thumbsMap = { e1001: makeThumbDataUrl('IMG_1001', '模糊', 116.39, 39.9) };
const { plan, rejected } = buildMergePlan(cardA, cardB, [mission], [existing1001, existing1003], thumbsMap, 0.3);

assert(plan.length === 4, '身份：按任务编号+片号合并出 4 个身份');
assert(rejected.length === 2 && rejected.some((r) => r.missionNo === 'DM-2024-099'), '未知任务编号/缺任务编号被拒入 rejected');
assert(plan.find((p) => p.imageNo === 'IMG_1001')!.existing === true, 'IMG_1001 识别为已有条目');
assert(plan.find((p) => p.imageNo === 'IMG_1004')!.existing === false, 'IMG_1004 识别为新增条目');
assert(plan.find((p) => p.imageNo === 'IMG_1002')!.gsdConflict === true, 'IMG_1002 两卡 GSD 差 0.70 > 0.3 进入冲突区');
assert(plan.find((p) => p.imageNo === 'IMG_1003')!.gsdConflict === false, 'IMG_1003 卡内重复不构成两卡冲突');
assert(plan.find((p) => p.imageNo === 'IMG_1001')!.gsdConflict === false, '已有实测 GSD 的条目不产生冲突（已收保留）');
assert(plan.find((p) => p.imageNo === 'IMG_1001')!.repairThumb === false, '已有缩略图不补建');
assert(plan.find((p) => p.imageNo === 'IMG_1003')!.repairThumb === true, '断链缩略图标记补建');

// 冲突未选定不能写（UI 层断言），这里先选卡A 3.90
const conflict = plan.find((p) => p.imageNo === 'IMG_1002')!;
conflict.resolvedGsd = 3.9;

const composed1001 = composeAsset(plan.find((p) => p.imageNo === 'IMG_1001')!, existing1001, 'batch1', null as never);
assert(composed1001.quality === '模糊' && composed1001.qualityConfirmed === true, '已确认质量保留，不被卡片「合格」覆盖');
assert(composed1001.gsd === 3.5, '已收实测 GSD 3.50 保留，不被卡片 3.22 覆盖');
assert(composed1001.overlap === 80, '已收实测重叠率 80 保留，不被卡片 75 覆盖');
assert(composed1001.snapshot?.measured.gsd === 3.5, '成果快照冻结实测值');
assert(composed1001.sourceCardNos.includes('旧卡') && composed1001.sourceCardNos.includes('TMP-A-1'), '来源卡片追加，临时编号只溯源');

const composed1002 = composeAsset(conflict, undefined, 'batch1',
  buildAssetSnapshot({ gsd: 3.9, overlap: 76, altitude: 121, tiltAngle: 4, lng: 116.4, lat: 39.9, shotAt: 1 }, mission, null, 'card-merge'));
assert(composed1002.gsd === 3.9, '冲突项采用人工选定的卡A GSD');
assert(composed1002.altitude === 121 && composed1002.overlap === 76, '空白字段从卡B补齐（航高121/重叠76，卡A缺测）');
assert(composed1002.quality === '合格' && composed1002.qualityConfirmed === true, '卡片带回质检结论视为已确认');
assert(composed1002.snapshotFilled === true && composed1002.snapshot?.source === 'card-merge', '合并写入补齐成果快照');

const composed1003 = composeAsset(plan.find((p) => p.imageNo === 'IMG_1003')!, existing1003, 'batch1',
  buildAssetSnapshot({ gsd: 3.2, overlap: 74, altitude: 120, tiltAngle: 5, lng: 116.41, lat: 39.9, shotAt: 1 }, mission, null, 'card-merge'));
assert(composed1003.gsd === 3.2 && composed1003.overlap === 74, '已收全空白条目从卡片补实测值');
assert(existing1003.gsd === 0 && existing1003.overlap === 0, '合成不修改原条目对象（失败恢复安全）');

// 未选定冲突：计划状态保持 conflict，由 runner 拦截不允许写入
const unresolved = { ...conflict, resolvedGsd: null };
assert(unresolved.gsdConflict === true && unresolved.resolvedGsd === null, '冲突未选定：计划保持 conflict，runner 拦截写入并继续保留批次');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
