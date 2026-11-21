/**
 * 清掉测试产物（`smoke-out/`）。
 *
 * 跑法：`npm run clean`
 *
 * 只删这一个目录，且只删仓库根下的那个：`smoke-out` 里全是重跑一次就会重建的
 * 测试片、拼图和清单，没有用户数据。
 */

import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'smoke-out');

// 先确认目标就是仓库根下的 smoke-out，避免路径算错删到别处。
if (dirname(TARGET) !== ROOT) throw new Error(`refusing to delete outside the repo: ${TARGET}`);

try {
  const info = await stat(TARGET);
  if (!info.isDirectory()) throw new Error(`${TARGET} is not a directory`);
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log('smoke-out/ 不存在，没什么可清的');
    process.exit(0);
  }
  throw error;
}

await rm(TARGET, { recursive: true, force: true });
console.log(`已删除 ${TARGET}`);
