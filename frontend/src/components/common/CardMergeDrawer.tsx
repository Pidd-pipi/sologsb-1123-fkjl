import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleTwoTone,
  ExclamationCircleTwoTone,
  PlayCircleOutlined,
  RedoOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { MergeBatch, MergeResult, ParsedCard } from '../../types/cardMerge';
import { DEFAULT_GSD_TOLERANCE, parseCardManifest, planStats } from '../../utils/cardMerge';
import { useMergeStore } from '../../stores/mergeStore';

export interface CardMergeDrawerProps {
  open: boolean;
  missionNo: string;
  /** 断点重试：传入未完成批次；首次接入不传 */
  batch?: MergeBatch;
  onClose: () => void;
  onExecuted: (ok: boolean, stats?: MergeResult) => void;
}

/** 两张卡示例清单：含重复片号折叠、空白互补、GSD 超容差冲突、非本任务拒入行 */
const SAMPLE_A = `任务编号	片号	卡片临时编号	经度	纬度	航高	实测GSD	实测重叠率	倾角	拍摄时间	质量	归档目录
DM-2024-018	IMG_1007	TMP-A-07	116.3988	39.9062	120	3.24	75	3	2024-09-12 10:20:07	合格	/DM-2024-018/100MEDIA
DM-2024-018	IMG_1008	TMP-A-08	116.4000	39.9062	120	3.21		4	2024-09-12 10:20:11		/DM-2024-018/100MEDIA
DM-2024-018	IMG_1009	TMP-A-09	116.4012	39.9053	120	3.90	72	5	2024-09-12 10:20:15	合格	/DM-2024-018/100MEDIA
DM-2024-018	IMG_1010	TMP-A-10	116.4024	39.9053			74	3	2024-09-12 10:20:19	合格	/DM-2024-018/100MEDIA
DM-2024-018	IMG_1010	TMP-A-10D	116.4024	39.9053	120	3.22				2024-09-12 10:20:19`;

const SAMPLE_B = `任务编号	片号	卡片临时编号	经度	纬度	航高	实测GSD	实测重叠率	倾角	拍摄时间	质量	归档目录
DM-2024-018	IMG_1008	TMP-B-21	116.4000	39.9062	120	3.23	74	4	2024-09-12 10:20:11	合格
DM-2024-018	IMG_1009	TMP-B-22	116.4012	39.9053	120	3.20	73	5	2024-09-12 10:20:15
DM-2024-018	IMG_1011	TMP-B-23	116.4036	39.9044	120	3.22	76	2	2024-09-12 10:20:23	合格	/DM-2024-018/101MEDIA
DM-2024-099	IMG_2001	TMP-B-99	116.5000	39.9900	120	3.30	70	3	2024-09-12 10:21:00	合格	/DM-2024-099/100MEDIA`;

/** 成果编目页：接入两张外业卡清单，按任务编号+片号合并，冲突人工选定 */
export default function CardMergeDrawer({ open, missionNo, batch: initialBatch, onClose, onExecuted }: CardMergeDrawerProps) {
  const { batches, createBatch, resolveConflict, runBatch, discardBatch } = useMergeStore();
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [tolerance, setTolerance] = useState(DEFAULT_GSD_TOLERANCE);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [stagedId, setStagedId] = useState<string | null>(initialBatch?.id ?? null);
  const [running, setRunning] = useState(false);
  const [parseError, setParseError] = useState('');

  const batch = useMemo(
    () => (stagedId ? batches.find((b) => b.id === stagedId) ?? null : initialBatch ?? null),
    [batches, stagedId, initialBatch],
  );

  const stats = useMemo(() => (batch ? planStats(batch.plan) : null), [batch]);
  const resume = Boolean(batch && (batch.status === 'failed' || batch.status === 'staged'));

  const stage = async () => {
    setParseError('');
    const cardA: ParsedCard | null = textA.trim() ? parseCardManifest(textA, 'A') : null;
    const cardB: ParsedCard | null = textB.trim() ? parseCardManifest(textB, 'B') : null;
    if (!cardA && !cardB) {
      setParseError('两张卡清单都为空，请至少粘贴一张卡的清单');
      return;
    }
    if ((cardA && cardA.invalidRows.length > 0) || (cardB && cardB.invalidRows.length > 0)) {
      setParseError(
        `存在无法解析的清单行：卡A ${cardA?.invalidRows.length ?? 0} 行、卡B ${cardB?.invalidRows.length ?? 0} 行，请修正后再接入`,
      );
      return;
    }
    const created = await createBatch({ cardA, cardB, tolerance, simulateFailure });
    setStagedId(created.id);
  };

  const execute = async () => {
    if (!batch) return;
    setRunning(true);
    try {
      const outcome = await runBatch(batch.id);
      onExecuted(outcome.ok, outcome.stats);
    } finally {
      setRunning(false);
    }
  };

  const discard = async () => {
    if (!batch) return;
    await discardBatch(batch.id);
    setStagedId(null);
    setTextA('');
    setTextB('');
    setSimulateFailure(false);
    onClose();
  };

  const conflictRows = batch?.plan.filter((p) => p.gsdConflict) ?? [];
  const invalidRows = [
    ...(batch?.cardA?.invalidRows.map((r) => ({ slot: 'A' as const, ...r })) ?? []),
    ...(batch?.cardB?.invalidRows.map((r) => ({ slot: 'B' as const, ...r })) ?? []),
  ];

  return (
    <Drawer
      title={batch ? `两卡清单合并 · ${missionNo}` : `接入两张存储卡清单 · ${missionNo}`}
      width={920}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
      extra={
        batch ? (
          <Space>
            <Button onClick={discard}>放弃批次</Button>
            <Button
              type="primary"
              icon={batch.status === 'failed' ? <RedoOutlined /> : <PlayCircleOutlined />}
              loading={running}
              disabled={batch.status === 'done' || (stats?.unresolved ?? 0) > 0}
              onClick={execute}
            >
              {batch.status === 'failed'
                ? `从未完成批次继续（已完成 ${batch.nextChunk * batch.chunkSize}/${batch.plan.length}）`
                : batch.status === 'done'
                  ? '已写入编目'
                  : `写入编目（${batch.plan.length} 张）`}
            </Button>
          </Space>
        ) : undefined
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {parseError ? <Alert type="error" showIcon message={parseError} /> : null}

        {!batch ? (
          <>
            <Alert
              type="info"
              showIcon
              message="按「任务编号 + 片号」认作同一张影像；卡片临时编号只作溯源。已确认质量、实测重叠率和缩略图保留，空白字段从另一张卡补齐。"
            />
            <Space wrap>
              <span>
                实测 GSD 容差{' '}
                <InputNumber value={tolerance} min={0.01} step={0.05} precision={2} onChange={(v) => setTolerance(Number(v) || DEFAULT_GSD_TOLERANCE)} />{' '}
                cm/px，两卡差值超过该值进入冲突区
              </span>
              <Button size="small" type="link" onClick={() => { setTextA(SAMPLE_A); setTextB(SAMPLE_B); }}>
                填入示例两卡清单
              </Button>
            </Space>
            <div>
              <Typography.Text strong>存储卡 A 清单（首行表头，支持 Tab / 逗号 / 分号分隔）</Typography.Text>
              <Input.TextArea rows={7} value={textA} onChange={(e) => setTextA(e.target.value)} placeholder="任务编号	片号	卡片临时编号	经度	纬度	…" style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </div>
            <div>
              <Typography.Text strong>存储卡 B 清单（可只贴一张卡）</Typography.Text>
              <Input.TextArea rows={7} value={textB} onChange={(e) => setTextB(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </div>
            <Space wrap>
              <Checkbox checked={simulateFailure} onChange={(e) => setSimulateFailure(e.target.checked)}>
                <ThunderboltOutlined /> 首次写入时模拟一次中断（用于验收失败恢复与断点重试）
              </Checkbox>
            </Space>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={stage}>
              解析并生成合并计划
            </Button>
          </>
        ) : (
          <>
            {batch.status === 'failed' ? (
              <Alert
                type="error"
                showIcon
                icon={<ExclamationCircleTwoTone twoToneColor="#cf1322" />}
                message={`上次写入失败，原编目已整体恢复：${batch.lastError}`}
                description={`卡片清单、冲突判定与已完成进度（${batch.nextChunk * batch.chunkSize}/${batch.plan.length}）均已保留，冲突无需重新判定，点右上角「从未完成批次继续」即可重试（第 ${batch.attempts + 1} 次执行）。`}
              />
            ) : null}
            {batch.status === 'done' ? (
              <Alert type="success" showIcon icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} message="两卡成果已写入同一编目，台账、成果页与导出看到同一结果" />
            ) : null}
            {resume && (stats?.unresolved ?? 0) > 0 ? (
              <Alert type="warning" showIcon message={`还有 ${stats?.unresolved} 个 GSD 冲突未选定，选定后才能写入`} />
            ) : null}

            <Space wrap size={8}>
              <Tag color="blue">计划 {stats?.total} 张</Tag>
              <Tag color="green">新增 {stats?.added}</Tag>
              <Tag color="cyan">并入已有 {stats?.merged}</Tag>
              <Tag color={stats && stats.conflicts > 0 ? 'red' : 'default'}>GSD 冲突 {stats?.conflicts}</Tag>
              <Tag color="orange">待修补缩略图 {stats?.thumbRepair}</Tag>
              <Tag>容差 {batch.gsdTolerance} cm/px</Tag>
            </Space>

            {conflictRows.length > 0 ? (
              <div>
                <Typography.Title level={5}>冲突区（两卡实测 GSD 差超过容差，必须人工选定）</Typography.Title>
                <Table
                  size="small"
                  rowKey="key"
                  pagination={false}
                  dataSource={conflictRows}
                  columns={[
                    { title: '片号', dataIndex: 'imageNo', width: 130 },
                    {
                      title: `卡A 实测 GSD`,
                      width: 150,
                      render: (_, r) => (r.gsdA === null ? <Typography.Text type="secondary">缺测</Typography.Text> : `${r.gsdA} cm/px`),
                    },
                    {
                      title: `卡B 实测 GSD`,
                      width: 150,
                      render: (_, r) => (r.gsdB === null ? <Typography.Text type="secondary">缺测</Typography.Text> : `${r.gsdB} cm/px`),
                    },
                    {
                      title: '人工选定',
                      render: (_, r) => {
                        const canPick = r.gsdA !== null || r.gsdB !== null;
                        const options = [
                          ...(r.gsdA !== null ? [{ value: r.gsdA, label: `采用卡A（${r.cardA?.cardNo}） ${r.gsdA}` }] : []),
                          ...(r.gsdB !== null ? [{ value: r.gsdB, label: `采用卡B（${r.cardB?.cardNo}） ${r.gsdB}` }] : []),
                        ];
                        return canPick ? (
                          <Radio.Group
                            size="small"
                            value={r.resolvedGsd}
                            onChange={(e) => resolveConflict(batch.id, r.key, Number(e.target.value))}
                            options={options}
                            optionType="button"
                            buttonStyle="solid"
                          />
                        ) : (
                          <Typography.Text type="warning">两卡均缺测，将按空白保留</Typography.Text>
                        );
                      },
                    },
                    {
                      title: '状态',
                      width: 90,
                      render: (_, r) =>
                        r.resolvedGsd === null ? <Tag color="red">待选定</Tag> : <Tag color="green">已选定 {r.resolvedGsd}</Tag>,
                    },
                  ]}
                />
              </div>
            ) : null}

            <div>
              <Typography.Title level={5}>合并明细（身份：任务编号 + 片号）</Typography.Title>
              <Table
                size="small"
                rowKey="key"
                pagination={{ pageSize: 8 }}
                dataSource={batch.plan}
                columns={[
                  { title: '片号', dataIndex: 'imageNo', width: 120 },
                  {
                    title: '处理',
                    width: 90,
                    render: (_, r) => (r.existing ? <Tag color="cyan">并入已有</Tag> : <Tag color="green">新增</Tag>),
                  },
                  {
                    title: '卡片临时编号（仅溯源）',
                    render: (_, r) => (
                      <Space size={4} wrap>
                        {r.cardA ? <Tag>{r.cardA.cardNo}</Tag> : null}
                        {r.cardB ? <Tag>{r.cardB.cardNo}</Tag> : null}
                        {r.duplicateInCard > 0 ? <Tag color="orange">卡内重复×{r.duplicateInCard + 1}</Tag> : null}
                      </Space>
                    ),
                  },
                  {
                    title: '实测 GSD',
                    width: 220,
                    render: (_, r) => {
                      const chosen = r.gsdExisting ?? r.resolvedGsd ?? r.gsdA ?? r.gsdB;
                      return (
                        <Space size={6}>
                          <span>{chosen !== null && chosen !== undefined ? `${chosen} cm/px` : '—'}</span>
                          {r.gsdExisting !== null ? <Tag color="blue">已收保留</Tag> : null}
                          {r.repairThumb ? <Tag color="geekblue">补缩略图</Tag> : null}
                        </Space>
                      );
                    },
                  },
                ]}
              />
            </div>

            {(batch.rejected.length > 0 || invalidRows.length > 0) ? (
              <div>
                <Typography.Title level={5}>未纳入条目</Typography.Title>
                <Table
                  size="small"
                  rowKey={(r) => `${r.missionNo}-${r.imageNo}-${r.cardNo}-${'reason' in r ? r.reason : ''}`}
                  pagination={false}
                  dataSource={[
                    ...batch.rejected.map((r) => ({ ...r, cardNo: r.cardNo })),
                    ...invalidRows.map((r) => ({ missionNo: '—', imageNo: `第${r.lineNo}行`, cardNo: `卡${r.slot}`, reason: r.reason })),
                  ]}
                  columns={[
                    { title: '任务编号', dataIndex: 'missionNo', width: 160 },
                    { title: '片号/行', dataIndex: 'imageNo', width: 140 },
                    { title: '卡片', dataIndex: 'cardNo', width: 120 },
                    { title: '原因', dataIndex: 'reason' },
                  ]}
                />
              </div>
            ) : null}
          </>
        )}
      </Space>
    </Drawer>
  );
}
