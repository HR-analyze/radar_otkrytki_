import seed from '../../fixtures/staffing-norms.json';
import type { StaffNorm } from './staffing';

/**
 * Нормы выхода сотрудников из репозитория — разобранный шаблон «по
 * часам-пикам» (см. scripts/build-staffing.ts).
 *
 * JSON импортируется, а не читается с диска: так он гарантированно доезжает
 * до serverless-функции, а весит считанные килобайты. Правок с сайта у норм
 * нет — новая версия шаблона приходит пересборкой файла и коммитом, и в диффе
 * видно, у какой лавки что поменялось.
 */

export interface StaffingSeed {
  source: string;
  builtAt: string;
  norms: StaffNorm[];
}

export const STAFFING_SEED_PATH = 'fixtures/staffing-norms.json';

export function readStaffing(): StaffingSeed {
  return seed as StaffingSeed;
}
