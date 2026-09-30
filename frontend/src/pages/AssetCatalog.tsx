import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { DownloadOutlined, PlusOutlined, SnippetsOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useMergeStore } from '../stores/mergeStore';
import AssetGrid from '../components/common/AssetGrid';
import AmapRouteView from '../components/common/AmapRouteView';
import CardMergeDrawer from '../components/common/CardMergeDrawer';
import { IMAGE_QUALITIES, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';
import type { MergeResult } from '../types/cardMerge';
import { calcGsd, distanceMeters } from '../utils/geoCalc';

/** /missions/:id/assets 成果影像编目：格子列出片号/缩略图/GSD/质量，多选标记、定位到图 */
export default function AssetCatalog() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const thumbs = useAssetStore((s) => s.thumbs);
  const addMany = useAssetStore((s) => s.addMany);
  const markMany = useAssetStore((s) => s.markMany);
  const removeMany = useAssetStore((s) => s.removeMany);
  const reloadAssets = useAssetStore((s) => s.load);
  const mergeBatches = useMergeStore((s) => s.batches);
  const loadBatches = useMergeStore((s) => s.load);

  const mission = missions.find((m) => m.id === id);
  const missionAssets = useMemo(
    () => assets.filter((a) => a.missionId === id).sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true })),
    [assets, id],
  );
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );

  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [qualityFilter, setQualityFilter] = useState<ImageQuality | 'all'>('all');
  const [locateSeq, setLocateSeq] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [resumeBatchId, setResumeBatchId] = useState<string | undefined>(undefined);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  /** 与当前任务相关、上次失败的合并批次（原编目已恢复，可从断点继续） */
  const failedBatches = useMemo(
    () =>
      mergeBatches.filter(
        (b) => b.status === 'failed' && b.plan.some((p) => p.missionId === id),
      ),
    [mergeBatches, id],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = missionAssets.filter((a) => {
    if (qualityFilter !== 'all' && a.quality !== qualityFilter) return false;
    if (keyword && !a.imageNo.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    return true;
  });

  const stats = IMAGE_QUALITIES.map((quality) => ({
    quality,
    count: missionAssets.filter((a) => a.quality === quality).length,
  }));

  /** 批量编目：按航点位置与当前航线 GSD 生成影像条目 */
  const catalogFromWaypoints = async () => {
    if (!mission) return;
    if (missionWaypoints.length === 0) {
      setError('该任务暂无航点，请先到「航点明细」录入或点击网格新增');
      return;
    }
    const gsd = calcGsd(mission.pixelSize, missionWaypoints[0].altitude, mission.focalLength);
    const startNo = missionAssets.length + 1;
    const drafts: ImageAssetDraft[] = missionWaypoints.map((w, index) => ({
      missionId: mission.id,
      imageNo: `IMG_${String(2000 + startNo + index)}`,
      lng: w.lng,
      lat: w.lat,
      altitude: w.altitude,
      gsd: calcGsd(mission.pixelSize, w.altitude, mission.focalLength) || gsd,
      overlap: 75,
      tiltAngle: Math.abs(w.gimbalPitch + 90),
      shotAt: Date.now() + index * 1000,
      quality: '合格' as ImageQuality,
      folder: `/${mission.missionNo}/100MEDIA`,
    }));
    await addMany(drafts);
    setError('');
    setToast(`已按 ${drafts.length} 个航点批量编目影像条目（GSD ${gsd} cm/px）`);
  };

  const locate = (asset: ImageAsset) => {
    if (missionWaypoints.length === 0) return;
    let best = missionWaypoints[0];
    let bestDist = Number.POSITIVE_INFINITY;
    missionWaypoints.forEach((w) => {
      const d = distanceMeters([asset.lng, asset.lat], [w.lng, w.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    });
    setLocateSeq(best.seq);
    setToast(`已定位到航点 #${best.seq}（距离 ${bestDist.toFixed(1)} m）`);
  };

  const exportList = () => {
    const header = '片号,卡片临时编号,来源卡片,经度,纬度,航高m,GSDcm/px,重叠%,倾角°,质量,质量已确认,归档目录,快照';
    const lines = missionAssets.map((a) =>
      [
        a.imageNo,
        a.cardNo,
        a.sourceCardNos.join('/'),
        a.lng,
        a.lat,
        a.altitude,
        a.gsd,
        a.overlap,
        a.tiltAngle,
        a.quality,
        a.qualityConfirmed ? '是' : '否',
        a.folder,
        a.snapshotFilled ? '已冻结' : '缺失',
      ].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `成果影像清单_${mission?.missionNo ?? 'mission'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${lines.length} 条影像清单`);
  };

  /** 两卡合并执行完：统一从同一存储层重新读取，台账/成果页/导出一致 */
  const onMergeExecuted = async (ok: boolean, stats?: MergeResult) => {
    await reloadAssets();
    await loadBatches();
    setSelected([]);
    if (ok && stats) {
      setToast(
        `两卡合并完成：新增 ${stats.added} 张、并入 ${stats.merged} 张、人工解冲突 ${stats.conflictsResolved} 个、补缩略图 ${stats.thumbsRepaired} 个、空白补齐 ${stats.blankFilled} 处`,
      );
    } else {
      setError('两卡合并中断，原编目已恢复；可在上方断点处继续重试');
    }
  };

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          成果影像编目 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>条目 {missionAssets.length} 张</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      {failedBatches.map((b) => (
        <Alert
          key={b.id}
          type="error"
          showIcon
          message={`两卡合并批次未完成（已写入 ${b.nextChunk * b.chunkSize}/${b.plan.length} 后中断，原编目已恢复）：${b.lastError}`}
          description="卡片清单与冲突判定均已保留，冲突无需重新选定。"
          action={
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setResumeBatchId(b.id);
                setMergeOpen(true);
              }}
            >
              从未完成批次继续
            </Button>
          }
        />
      ))}

      <Row gutter={12}>
        {stats.map((s) => (
          <Col span={6} key={s.quality}>
            <Card size="small">
              <Statistic title={`${s.quality}影像`} value={s.count} suffix="张" />
            </Card>
          </Col>
        ))}
        <Col span={6}>
          <Card size="small">
            <Statistic title="航点数量" value={missionWaypoints.length} suffix="个" />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap size={10}>
          <Input
            allowClear
            style={{ width: 200 }}
            placeholder="按片号筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            style={{ width: 140 }}
            value={qualityFilter}
            onChange={(v) => setQualityFilter(v as ImageQuality | 'all')}
            options={[{ value: 'all', label: '全部质量' }, ...IMAGE_QUALITIES.map((q) => ({ value: q, label: q }))]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={catalogFromWaypoints}>
            按航点批量编目
          </Button>
          <Button
            icon={<SnippetsOutlined />}
            onClick={() => {
              setResumeBatchId(undefined);
              setMergeOpen(true);
            }}
          >
            接入两卡清单合并
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '合格');
              setToast(`已把 ${selected.length} 张标记为「合格」`);
            }}
          >
            标记合格
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '模糊');
              setToast(`已把 ${selected.length} 张标记为「模糊」`);
            }}
          >
            标记模糊
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '过曝');
              setToast(`已把 ${selected.length} 张标记为「过曝」`);
            }}
          >
            标记过曝
          </Button>
          <Button
            danger
            disabled={selected.length === 0}
            onClick={async () => {
              await removeMany(selected);
              setToast(`已删除 ${selected.length} 条影像条目`);
              setSelected([]);
            }}
          >
            删除选中
          </Button>
          <Button icon={<DownloadOutlined />} onClick={exportList} disabled={missionAssets.length === 0}>
            导出成果清单
          </Button>
        </Space>
      </Card>

      <Row gutter={14}>
        <Col span={16}>
          <Card size="small" title={`影像格子（筛选后 ${filtered.length} 张）`}>
            <AssetGrid
              assets={filtered}
              thumbs={thumbs}
              selectedIds={selected}
              onToggle={(assetId) =>
                setSelected((prev) => (prev.includes(assetId) ? prev.filter((x) => x !== assetId) : [...prev, assetId]))
              }
              onToggleAll={(ids) => setSelected(ids)}
              onLocate={locate}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="定位到图">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={missionWaypoints[0]?.altitude ?? 120}
              height={340}
              highlightSeq={locateSeq}
            />
          </Card>
        </Col>
      </Row>

      <CardMergeDrawer
        open={mergeOpen}
        missionNo={mission.missionNo}
        batch={resumeBatchId ? mergeBatches.find((b) => b.id === resumeBatchId) : undefined}
        onClose={() => setMergeOpen(false)}
        onExecuted={onMergeExecuted}
      />
    </Space>
  );
}
