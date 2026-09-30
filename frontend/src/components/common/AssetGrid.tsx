import { Button, Card, Checkbox, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { AimOutlined, LinkOutlined } from '@ant-design/icons';
import { makeThumbDataUrl, type ImageAsset, type ImageQuality } from '../../types/imageasset';

export interface AssetGridProps {
  assets: ImageAsset[];
  thumbs: Record<string, string>;
  selectedIds: string[];
  onToggle: (id: string) => void;
  onToggleAll?: (ids: string[]) => void;
  onLocate?: (asset: ImageAsset) => void;
  emptyText?: string;
}

const QUALITY_COLOR: Record<ImageQuality, string> = {
  合格: 'green',
  模糊: 'gold',
  过曝: 'red',
};

/**
 * 成果影像格子：缩略图、片号、GSD、质量角标与多选。
 * 被成果编目页（/missions/:id/assets）消费。
 */
export default function AssetGrid({
  assets,
  thumbs,
  selectedIds,
  onToggle,
  onToggleAll,
  onLocate,
  emptyText = '暂无成果影像条目',
}: AssetGridProps) {
  if (assets.length === 0) {
    return <Empty description={emptyText} />;
  }

  const allSelected = selectedIds.length === assets.length;

  return (
    <div data-testid="asset-grid">
      <Space style={{ marginBottom: 10 }} size={10} wrap>
        <Checkbox
          checked={allSelected}
          indeterminate={selectedIds.length > 0 && !allSelected}
          onChange={() => onToggleAll?.(allSelected ? [] : assets.map((a) => a.id))}
        >
          全选（{assets.length} 张）
        </Checkbox>
        <Typography.Text type="secondary">已选 {selectedIds.length} 张</Typography.Text>
      </Space>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
          gap: 12,
        }}
      >
        {assets.map((asset) => {
          const selected = selectedIds.includes(asset.id);
          return (
            <Card
              key={asset.id}
              size="small"
              hoverable
              style={{ borderColor: selected ? '#1677ff' : undefined }}
              styles={{ body: { padding: 8 } }}
            >
              <div style={{ position: 'relative' }}>
                <img
                  src={thumbs[asset.id] ?? makeThumbDataUrl(asset.imageNo, asset.quality, asset.lng, asset.lat)}
                  alt={asset.imageNo}
                  style={{ width: '100%', display: 'block', borderRadius: 4, background: '#eef2f6' }}
                />
                <div style={{ position: 'absolute', top: 4, left: 4 }}>
                  <Checkbox checked={selected} onChange={() => onToggle(asset.id)} />
                </div>
                <div style={{ position: 'absolute', top: 4, right: 4 }}>
                  <Space size={4}>
                    {thumbs[asset.id] ? null : (
                      <Tooltip title="缩略图断链，合并时将自动补建">
                        <Tag icon={<LinkOutlined />} color="orange">断链</Tag>
                      </Tooltip>
                    )}
                    <Tag color={QUALITY_COLOR[asset.quality]}>{asset.quality}</Tag>
                  </Space>
                </div>
              </div>
              <Typography.Text strong style={{ display: 'block', marginTop: 6 }}>
                {asset.imageNo}
                {asset.qualityConfirmed ? (
                  <Tooltip title="质量已内业确认，两卡合并不覆盖">
                    <Tag color="green" style={{ marginLeft: 6 }}>质量已确认</Tag>
                  </Tooltip>
                ) : null}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                GSD {asset.gsd} cm/px · 重叠 {asset.overlap}% · 倾角 {asset.tiltAngle}°
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                航高 {asset.altitude} m · {new Date(asset.shotAt).toLocaleString('zh-CN')}
              </Typography.Text>
              <Space size={4} wrap style={{ marginTop: 2 }}>
                {asset.sourceCardNos.length > 0 ? (
                  <Tooltip title="外业卡片临时编号，仅作溯源，不作为影像身份">
                    <Tag>卡：{Array.from(new Set([...asset.sourceCardNos, asset.cardNo].filter(Boolean))).join('/')}</Tag>
                  </Tooltip>
                ) : null}
                {asset.snapshotFilled ? <Tag color="geekblue">快照已冻结</Tag> : <Tag color="orange">缺快照</Tag>}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis>
                {asset.folder}
              </Typography.Text>
              {onLocate ? (
                <Button size="small" type="link" icon={<AimOutlined />} onClick={() => onLocate(asset)}>
                  定位到图
                </Button>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
