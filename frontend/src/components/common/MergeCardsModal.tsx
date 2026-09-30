import { useRef } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Progress,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { CloudUploadOutlined, FileDoneOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMergeStore } from '../../stores/useMergeStore';
import type { ImageAsset } from '../../types/imageasset';
import type { MergeField, MergeItem, MergeSource } from '../../types/merge';

const { TextArea } = Input;

export interface MergeCardsModalProps {
  open: boolean;
  missionId: string;
  missionNo: string;
  base: ImageAsset[];
  baseThumbs: Record<string, string>;
  onClose: () => void;
  onMerged: () => void;
}

const FIELD_LABEL: Record<MergeField, string> = {
  lng: '经度',
  lat: '纬度',
  altitude: '航高',
  gsd: 'GSD',
  overlap: '重叠率',
  tiltAngle: '倾角',
  shotAt: '拍摄时间',
  quality: '质量',
  folder: '归档目录',
  thumb: '缩略图',
};

const SOURCE_LABEL: Record<MergeSource, string> = { base: '编目保留', A: 'A 卡', B: 'B 卡' };

/** 成果编目页「两卡合并」：接两张外业卡清单，按 (任务编号, 片号) 认同一张，空白补齐、保留实测值，GSD 超容差进冲突区人工选定后写入 */
export default function MergeCardsModal({ open, missionId, missionNo, base, baseThumbs, onClose, onMerged }: MergeCardsModalProps) {
  const {
    cardAText,
    cardBText,
    cardA,
    cardB,
    plan,
    writable,
    applying,
    progress,
    runStatus,
    error,
    toast,
    setCardAText,
    setCardBText,
    parseCard,
    loadSample,
    buildPlan,
    resolve,
    apply,
    reset,
    clearToast,
  } = useMergeStore();
  const fileARef = useRef<HTMLInputElement>(null);
  const fileBRef = useRef<HTMLInputElement>(null);

  const readFile = (side: 'A' | 'B', file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      if (side === 'A') setCardAText(text);
      else setCardBText(text);
      // 文本写入后立即解析
      window.setTimeout(() => parseCard(side), 0);
    };
    reader.readAsText(file);
  };

  const columns: TableProps<MergeItem>['columns'] = [
    { title: '片号', dataIndex: 'imageNo', width: 120, render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: '来源',
      width: 180,
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          {row.inBase ? <Tag color="default">编目</Tag> : null}
          {row.inA ? <Tag color="blue">A 卡</Tag> : null}
          {row.inB ? <Tag color="cyan">B 卡</Tag> : null}
        </Space>
      ),
    },
    {
      title: '空白补齐',
      width: 200,
      render: (_: unknown, row) =>
        row.fills.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.fills.map((f, i) => (
              <Tag key={i} color="gold">
                {FIELD_LABEL[f.field]} ← {SOURCE_LABEL[f.from]}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '保留',
      width: 200,
      render: (_: unknown, row) =>
        row.retained.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {row.retained.map((f, i) => (
              <Tag key={i} color="green">
                {FIELD_LABEL[f]}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '缩略图',
      width: 110,
      render: (_: unknown, row) =>
        row.thumb ? (
          <Tag color={row.thumbFrom === 'base' ? 'green' : 'blue'}>{SOURCE_LABEL[row.thumbFrom ?? 'base']}图</Tag>
        ) : (
          <Tag color="red">将生成占位</Tag>
        ),
    },
    {
      title: 'GSD 冲突',
      width: 120,
      render: (_: unknown, row) =>
        row.conflict ? (
          row.conflict.pick ? (
            <Tag color="green">已选 {SOURCE_LABEL[row.conflict.pick]}</Tag>
          ) : (
            <Tag color="red">待选定</Tag>
          )
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Modal
      title={`两卡合并 · ${missionNo}`}
      open={open}
      onCancel={() => {
        onClose();
        reset();
      }}
      width={1080}
      footer={
        <Space wrap>
          <Button onClick={() => loadSample(missionNo, base)} icon={<ThunderboltOutlined />}>
            载入示例卡片
          </Button>
          <Button
            onClick={() => buildPlan(missionNo, base, baseThumbs)}
            disabled={!cardA || !cardB}
            icon={<FileDoneOutlined />}
          >
            生成合并预览
          </Button>
          <Button
            type="primary"
            disabled={!plan || !writable || applying}
            loading={applying}
            onClick={async () => {
              await apply(missionId);
              if (useMergeStore.getState().runStatus === 'done') {
                onMerged();
              }
            }}
          >
            写入编目
          </Button>
          <Button
            onClick={() => {
              onClose();
              reset();
            }}
          >
            关闭
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {toast ? <Alert type="success" showIcon message={toast} closable onClose={clearToast} /> : null}
        {error ? <Alert type="error" showIcon message={error} closable onClose={() => useMergeStore.setState({ error: '' })} /> : null}

        <Alert
          type="info"
          showIcon
          message="认片身份是「任务编号 + 片号」，卡片临时编号仅作卡片内引用、不当身份；空白字段从另一张补，已确认质量 / 实测重叠率 / 实测 GSD / 缩略图保留。"
        />

        <Row gutter={12}>
          {(['A', 'B'] as const).map((side) => {
            const text = side === 'A' ? cardAText : cardBText;
            const parsed = side === 'A' ? cardA : cardB;
            return (
              <Col span={12} key={side}>
                <Card
                  size="small"
                  title={
                    <Space>
                      <CloudUploadOutlined />
                      {side} 卡清单
                      {parsed ? <Tag color="green">已解析 {parsed.assets.length} 条</Tag> : null}
                    </Space>
                  }
                  extra={
                    <Space size={4}>
                      <input
                        ref={side === 'A' ? fileARef : fileBRef}
                        type="file"
                        accept=".json,.csv,application/json,text/csv"
                        style={{ display: 'none' }}
                        onChange={(e) => readFile(side, e.target.files?.[0] ?? undefined)}
                      />
                      <Button size="small" onClick={() => (side === 'A' ? fileARef.current?.click() : fileBRef.current?.click())}>
                        导入文件
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        onClick={() => parseCard(side)}
                        disabled={!text.trim()}
                      >
                        解析
                      </Button>
                    </Space>
                  }
                >
                  <TextArea
                    rows={6}
                    placeholder={`粘贴 ${side} 卡 JSON 或 CSV（含 imageNo,gsd,overlap,quality,folder,thumb 等列）`}
                    value={text}
                    onChange={(e) => (side === 'A' ? setCardAText(e.target.value) : setCardBText(e.target.value))}
                  />
                </Card>
              </Col>
            );
          })}
        </Row>

        {plan ? (
          <>
            <Row gutter={12}>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="片号总数" value={plan.stats.total} suffix="张" />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="匹配（≥2方）" value={plan.stats.matched} suffix="张" />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="空白补齐" value={plan.stats.fillCount} suffix="项" />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="保留实测/确认" value={plan.stats.retainedCount} suffix="项" />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="仅 A / 仅 B" value={`${plan.stats.onlyA} / ${plan.stats.onlyB}`} />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="GSD 冲突" value={plan.stats.conflictCount} suffix="处" valueStyle={{ color: plan.stats.conflictCount ? '#cf1322' : undefined }} />
                </Card>
              </Col>
            </Row>

            {plan.conflicts.length > 0 ? (
              <Card
                size="small"
                title={
                  <Space>
                    <Tag color="red">冲突区</Tag>
                    <span>两卡实测 GSD 相差超过容差，人工选定后才写入</span>
                  </Space>
                }
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {plan.conflicts.map((c) => (
                    <Card.Grid key={c.key} style={{ width: '100%', padding: 12 }}>
                      <Space wrap align="center">
                        <Typography.Text strong>{c.imageNo}</Typography.Text>
                        <Tag color="red">相对差异 {(c.delta * 100).toFixed(1)}% {'>'} 容差 {(c.tolerance * 100).toFixed(0)}%</Tag>
                        <Radio.Group
                          value={c.pick}
                          onChange={(e) => resolve(c.key, e.target.value as MergeSource)}
                          optionType="button"
                          buttonStyle="solid"
                        >
                          {c.base !== undefined ? <Radio.Button value="base">编目保留 GSD {c.base}</Radio.Button> : null}
                          {c.a !== undefined ? <Radio.Button value="A">A 卡 GSD {c.a}</Radio.Button> : null}
                          {c.b !== undefined ? <Radio.Button value="B">B 卡 GSD {c.b}</Radio.Button> : null}
                        </Radio.Group>
                        {!c.pick ? <Typography.Text type="warning">未选定，不可写入</Typography.Text> : <Tag color="green">已选定</Tag>}
                      </Space>
                    </Card.Grid>
                  ))}
                </Space>
              </Card>
            ) : null}

            <Card size="small" title={`合并明细（${plan.items.length} 条）`}>
              <Table<MergeItem>
                rowKey="key"
                size="small"
                columns={columns}
                dataSource={plan.items}
                pagination={{ pageSize: 8, size: 'small' }}
                scroll={{ x: 900 }}
                locale={{ emptyText: '暂无合并项' }}
              />
            </Card>

            {applying ? (
              <Card size="small">
                <Progress percent={Math.round(progress * 100)} status="active" />
                <Typography.Text type="secondary">正在分批写入编目…</Typography.Text>
              </Card>
            ) : null}
            {runStatus === 'rolled_back' ? (
              <Alert
                type="warning"
                showIcon
                message="上次写入失败已恢复原编目"
                description="可点击「写入编目」重试：写入按 (任务编号, 片号) 幂等进行，不会产生重复条目，并从未完成批次继续。"
              />
            ) : null}
          </>
        ) : null}
      </Space>
    </Modal>
  );
}
