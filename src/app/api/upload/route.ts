import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { invalidateSnapshot } from '@/lib/snapshot';
import { canEditShowcase, saveShowcaseEdits } from '@/lib/showcase-store';
import { checkUploadToken, saveUploads, uploadCapability, type SaveResult } from '@/lib/upload-store';
import { appendUploadLog } from '@/lib/upload-log';
import { plural } from '@/lib/plural';
import { inspectUpload, MAX_UPLOAD_BYTES, type UploadInspection } from '@/lib/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Приём выгрузок кнопкой с дашборда.
 *
 * Файл сначала разбирается теми же парсерами, что и сборка снимка, и только
 * потом сохраняется: нераспознанное не попадает ни в папку, ни в репозиторий,
 * а человек получает не «ошибка 500», а строку о том, что именно не так.
 *
 * Пачка файлов сохраняется целиком (в режиме github — одним коммитом), но
 * нераспознанные файлы её не блокируют: они возвращаются со своей причиной,
 * остальные проходят.
 */
export async function POST(req: Request) {
  const capability = uploadCapability();
  if (capability.mode === 'unavailable') {
    // 503, а не 500: это не сбой, а ненастроенная возможность — как у кнопки «Обновить».
    return NextResponse.json({ ok: false, error: capability.hint }, { status: 503 });
  }

  const token = checkUploadToken(req);
  if (!token.ok) {
    return NextResponse.json({ ok: false, error: token.reason }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Не удалось прочитать файлы. Если файл большой, загрузите его отдельно: ' +
          `на один запрос помещается около ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ.`,
      },
      { status: 400 },
    );
  }

  const uploaded = form.getAll('files').filter((v): v is File => v instanceof File);
  if (uploaded.length === 0) {
    return NextResponse.json({ ok: false, error: 'Файлы не приложены' }, { status: 400 });
  }

  const config = loadConfig();
  const accepted: { inspection: UploadInspection; buffer: Buffer }[] = [];
  const results: FileResult[] = [];

  for (const file of uploaded) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const inspected = inspectUpload(file.name, buffer, config);

    if (!inspected.ok) {
      results.push({ ok: false, name: inspected.originalName, error: inspected.error });
      continue;
    }

    accepted.push({ inspection: inspected.file, buffer });
    results.push({
      ok: true,
      name: inspected.file.originalName,
      savedAs: inspected.file.fileName,
      kind: inspected.file.kind,
      summary: inspected.file.summary,
      dates: inspected.file.dates,
      unknownRoles: inspected.file.unknownRoles,
      notes: inspected.file.notes,
    });
  }

  if (accepted.length === 0) {
    return NextResponse.json(
      { ok: false, mode: capability.mode, files: results, error: 'Ни один файл не распознан' },
      { status: 400 },
    );
  }

  try {
    // Книга витрин из Google-таблицы в fixtures/ не кладётся: её значения
    // уходят только в базу (см. inspectShowcaseBook), и коммит ради неё
    // перезапускал бы деплой. Пачка из одной такой книги видна сразу.
    const files = accepted.filter((a) => a.inspection.kind !== 'showcase');
    const saved: SaveResult =
      files.length > 0
        ? await saveUploads(files, capability)
        : { mode: capability.mode as SaveResult['mode'], visible: 'now', notes: [] };

    // Наполнение витрин из книги «Витрины» и из Google-таблицы — в базу ручных
    // данных. Книгу ведут руками и заливают целиком, поэтому её проценты
    // применяются как обычная пачка правок: значения из пустых ячеек не
    // приходят и ничего не затирают.
    const showcase = await importShowcase(accepted.map((a) => a.inspection));

    // Книга витрин сама по себе нигде не сохраняется: не легли значения в
    // базу — значит, не загрузилось ничего, и «✅» был бы неправдой.
    if (files.length === 0 && !showcase.saved) {
      return NextResponse.json(
        { ok: false, mode: capability.mode, files: results, error: showcase.notes.join(' ') },
        { status: 502 },
      );
    }

    // Журнал для вкладки «История»: что и когда загрузили.
    const at = new Date().toISOString();
    await appendUploadLog(
      accepted.map(({ inspection }) => ({
        at,
        originalName: inspection.originalName,
        fileName: inspection.fileName,
        kind: inspection.kind,
        summary: inspection.summary,
        dates: inspection.dates,
        rows: inspection.rows,
        mode: saved.mode,
      })),
    );

    return NextResponse.json({
      ok: true,
      mode: saved.mode,
      visible: saved.visible,
      notes: [...saved.notes, ...showcase.notes, ...(await normsOverrideNote(accepted.map((a) => a.inspection)))],
      commitUrl: saved.commitUrl,
      files: results,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        mode: capability.mode,
        files: results,
        error: `Файлы разобраны, но сохранить их не вышло. ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      { status: 502 },
    );
  }
}

/**
 * Проценты наполнения витрин из книги «Витрины» — в базу ручных данных.
 *
 * Книгу заполняют в Excel и заливают целиком, поэтому её значения применяются
 * тем же путём, что и правка ячейки на вкладке «Витрины»: база остаётся
 * единственным источником правды, а деплой к ней не притрагивается.
 *
 * Сбой импорта не роняет загрузку: файлы уже сохранены и разобраны, а человеку
 * важнее увидеть причину, чем получить 502 на всю пачку. Исключение — пачка из
 * одних книг витрин: им сохраняться больше негде, и её роут возвращает ошибкой.
 */
async function importShowcase(
  files: readonly UploadInspection[],
): Promise<{ notes: string[]; saved: boolean }> {
  const edits = files.flatMap((f) => f.showcase);
  if (edits.length === 0) return { notes: [], saved: false };

  if (!canEditShowcase()) {
    return {
      notes: ['Наполнение витрин из книги не сохранено: на этом хостинге нет диска под базу ручных данных.'],
      saved: false,
    };
  }

  try {
    const { changed } = await saveShowcaseEdits(edits, { source: 'upload' });
    // Снимок держит витрины в кеше — без сброса правки были бы видны не сразу.
    invalidateSnapshot();

    return {
      notes:
        changed === 0
          ? ['Наполнение витрин из книги совпало с тем, что уже в радаре — менять нечего.']
          : [
              `Наполнение витрин: обновлено ${changed} ` +
                `${plural(changed, 'значение', 'значения', 'значений')} из книги.`,
            ],
      saved: true,
    };
  } catch (e) {
    return {
      notes: [`Наполнение витрин из книги сохранить не вышло: ${e instanceof Error ? e.message : String(e)}`],
      saved: false,
    };
  }
}

/**
 * Правка с вкладки «Пороги» главнее справочника: у таких лавок новая таблица
 * не подействует. Называем их поимённо — иначе загрузку справочника легко
 * принять за неработающую.
 */
async function normsOverrideNote(files: readonly UploadInspection[]): Promise<string[]> {
  if (!files.some((f) => f.kind === 'norms')) return [];
  try {
    const { readNorms } = await import('@/lib/shop-norms-store');
    const manual = Object.values((await readNorms()).byCode)
      .filter((n) => n.source === 'manual')
      .map((n) => n.code)
      .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
    return manual.length === 0
      ? []
      : [
          `У ${manual.length} ${plural(manual.length, 'лавки', 'лавок', 'лавок')} нормы правили руками на вкладке «Пороги» — ` +
            `для них остаётся ручная правка, а не справочник: ${manual.join(', ')}. ` +
            'Чтобы лавка поехала по справочнику, сбросьте её правку на «Порогах».',
        ];
  } catch {
    return [];
  }
}

type FileResult =
  | {
      ok: true;
      name: string;
      savedAs: string;
      kind: string;
      summary: string;
      dates: string[];
      /** Должности, которых радар не знает: показываются в панели поимённо. */
      unknownRoles: { role: string; rows: number }[];
      /** Что парсер пропустил — короткими фразами. */
      notes: string[];
    }
  | { ok: false; name: string; error: string };
