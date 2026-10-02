import fs from 'node:fs';
import { CONFIG_PATH, ensureDataDir } from './util.js';

export interface Config {
  /** 判定"久未使用"的天数阈值 */
  thresholdDays: number;
  /** 安装后至少经过多少天且从未使用，才允许被标记为"从未使用" */
  graceDays: number;
  /** 永不清理的 formula 名单 */
  protect: string[];
  /** Web 服务端口 */
  port: number;
  /** 应用扫描目录 */
  appDirs: string[];
  /** 安装包扫描目录 */
  downloadDirs: string[];
  /** 项目根目录（扫描其中的 node_modules/.venv 依赖目录） */
  projectRoots: string[];
  /** 扫描 .zip 安装包（可能有误报） */
  includeZip: boolean;
}

export const DEFAULT_CONFIG: Config = {
  thresholdDays: 90,
  graceDays: 30,
  protect: ['git', 'curl'],
  port: 8642,
  appDirs: ['/Applications', '~/Applications'],
  downloadDirs: ['~/Downloads'],
  projectRoots: ['~/pidev', '~/dev', '~/projects', '~/code', '~/work', '~/Documents'],
  includeZip: false,
};

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: Config): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
