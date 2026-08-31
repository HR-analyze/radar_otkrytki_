import fs from 'node:fs';
import path from 'node:path';
import { commitFixtures, githubTargetFromEnv } from './connectors/github';
import { invalidateSnapshot, storageMode } from './snapshot';
import { isSupersededBy, type UploadInspection } from './uploads';

/**
 * Куда попадает файл, загруженный кнопкой с дашборда.
 *
 * Ровно два рабочих варианта, и выбираются они сами:
 *
 *   disk   — папка выгрузок доступна на запись (локально, VPS): файл кладётся
 *            рядом с остальными и снимок сразу пересобирается, данные видно
 *            через секунду;
 *   github — записать некуда (Vercel), но настроен токен: файл коммитится в
 *            `fixtures/`, деплой по пушу пересобирает снимок сам.
 *
 * Если ни того ни другого — кнопка честно говорит, чего не хватает, вместо
 * того чтобы принять файл и потерять его.
 */

export type UploadMode = 'disk' | 'github' | 'unavailable';

export interface UploadCapability {
  mode: UploadMode;
  /** Что произойдёт после загрузки — показывается в панели до выбора файлов. */
  hint: string;
  /** Спрашивать ли код доступа (RADAR_UPLOAD_TOKEN). */
  tokenRequired: boolean;
}

export interface SaveResult {
  mode: 'disk' | 'github';
  /** Когда данные окажутся на дашборде: сразу, после пересборки или только руками. */
  visible: 'now' | 'after-deploy' | 'manual';
  /** Что стоит сказать человеку дополнительно (режим SQLite, замещённые файлы). */
  notes: string[];
  commitUrl?: string;
}

/*
 * Пометки turbopackIgnore ниже — про трассировку сборки, а не про поведение:
 * путь к папке выгрузок известен только в рантайме, и без них Next тянет в
 * бандл функции весь проект (тот же приём уже стоит в snapshot.ts).
 */
export function fixturesDir(): string {
  return process.env.RADAR_FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures');
}

/** Есть ли куда писать: на Vercel `/var/task` только для чтения. */
function fixturesWritable(): boolean {
  if (process.env.VERCEL) return false;
  try {
    fs.accessSync(/* turbopackIgnore: true */ fixturesDir(), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function uploadCapability(): UploadCapability {
  const tokenRequired = Boolean(process.env.RADAR_UPLOAD_TOKEN);

  if (fixturesWritable()) {
    return {
      mode: 'disk',
      hint: `Файлы лягут в ${path.relative(process.cwd(), fixturesDir()) || 'fixtures'}/, дашборд обновится сразу.`,
      tokenRequired,
    };
  }

  const target = githubTargetFromEnv();
  if (target) {
    return {
      mode: 'github',
      hint:
        `Файлы уедут коммитом в ${target.owner}/${target.repo} (ветка ${target.branch}), ` +
        'дашборд пересоберётся сам — это занимает пару минут.',
      tokenRequired,
    };
  }

  return {
    mode: 'unavailable',
    hint:
      'Загрузка не настроена: на этом хостинге писать некуда, а токен GitHub не задан. ' +
      'Добавьте переменную окружения RADAR_GITHUB_TOKEN (права Contents: Read and write) ' +
      'и передеплойте — см. README, раздел «Загрузка файлов с дашборда».',
    tokenRequired,
  };
}

/** Совпал ли код доступа, если он вообще включён. */
export function checkUploadToken(req: Request): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.RADAR_UPLOAD_TOKEN;
  if (!expected) return { ok: true };

  const got = req.headers.get('x-radar-upload-token') ?? '';
  if (got.length !== expected.length) return { ok: false, reason: 'Неверный код загрузки' };

  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: 'Неверный код загрузки' };
}

export async function saveUploads(
  files: readonly { inspection: UploadInspection; buffer: Buffer }[],
  capability: UploadCapability,
): Promise<SaveResult> {
  if (capability.mode === 'disk') return await saveToDisk(files);
  if (capability.mode === 'github') return saveToGithub(files);
  throw new Error(capability.hint);
}

async function saveToDisk(
  files: readonly { inspection: UploadInspection; buffer: Buffer }[],
): Promise<SaveResult> {
  const dir = fixturesDir();
  fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });

  const notes: string[] = [];
  const existing = fs.readdirSync(/* turbopackIgnore: true */ dir);
  const removed = new Set<string>();

  for (const { inspection, buffer } of files) {
    fs.writeFileSync(path.join(/* turbopackIgnore: true */ dir, inspection.fileName), buffer);

    // Тот же файл с другим расширением иначе останется лежать рядом, и в папке
    // окажутся две легаси-книги — см. commitFixtures.
    for (const old of existing) {
      if (isSupersededBy(old, inspection.fileName) && !removed.has(old)) {
        fs.rmSync(path.join(/* turbopackIgnore: true */ dir, old), { force: true });
        removed.add(old);
        notes.push(`Заменён прежний файл ${old}`);
      }
    }
  }

  // Снимок на диске — то, что читает дашборд в режиме снимка. Пересобираем
  // сразу, иначе файл лежит, а цифры прежние.
  const { buildSnapshot } = await import('./etl/snapshot-build');
  buildSnapshot({ fixturesDir: dir });
  invalidateSnapshot();

  if (storageMode() === 'sqlite') {
    notes.push(
      'Дашборд читает SQLite, а снимок пересобран отдельно: чтобы данные попали в БД, ' +
        'выполните npm run seed.',
    );
  }
  return {
    mode: 'disk',
    visible: storageMode() === 'sqlite' ? 'manual' : 'now',
    notes,
  };
}

async function saveToGithub(
  files: readonly { inspection: UploadInspection; buffer: Buffer }[],
): Promise<SaveResult> {
  const target = githubTargetFromEnv();
  if (!target) throw new Error(uploadCapability().hint);

  const result = await commitFixtures(
    target,
    files.map((f) => ({ name: f.inspection.fileName, buffer: f.buffer })),
    commitMessage(files.map((f) => f.inspection)),
  );

  return {
    mode: 'github',
    visible: 'after-deploy',
    notes: result.removed.map((name) => `Заменён прежний файл ${name}`),
    commitUrl: result.url,
  };
}

/** «Выгрузки с дашборда: 28.08 выходы, водители» — чтобы история читалась. */
function commitMessage(files: readonly UploadInspection[]): string {
  const dates = [...new Set(files.flatMap((f) => f.dates))].sort();
  const span =
    dates.length === 0
      ? ''
      : dates.length === 1
        ? ` за ${dates[0]}`
        : ` за ${dates[0]} — ${dates[dates.length - 1]}`;

  return `Загрузка с дашборда${span}: ${files.map((f) => f.fileName).join(', ')}`;
}
