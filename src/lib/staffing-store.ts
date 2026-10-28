import seed from '../../fixtures/staffing-norms.json';
import type { StaffNorm } from './staffing';
import { applyStaffingRules } from './staffing-rules';

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

/**
 * Нормы с расстановкой по правилам руководства поверх книг (см.
 * staffing-rules.ts). Правила — в коде, а не в JSON: поменялось правило — не
 * нужно пересобирать книги, а в JSON остаётся то, что вписали ТД.
 */
/** Нормы как в книгах, без правил руководства — для разбора старых правок. */
export function readStaffingBook(): StaffingSeed {
  return seed as StaffingSeed;
}

export function readStaffing(): StaffingSeed {
  const raw = seed as StaffingSeed;
  return { ...raw, norms: applyStaffingRules(raw.norms) };
}
