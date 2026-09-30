/** 生成本地唯一 id */
export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 由稳定业务键生成确定性 id（不随时间/随机数变化）。
 * 用于两卡合并：同一 (任务编号, 片号) 在重试时始终映射到同一条目，保证幂等。
 */
export function stableId(prefix: string, key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  }
  return `${prefix}_${(h >>> 0).toString(36)}`;
}

/** 下一个航点序号 */
export function nextSeq(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
