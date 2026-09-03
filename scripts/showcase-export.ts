/**
 * Резервная копия наполнения витрин: база → `fixtures/showcase.json`.
 *   npm run showcase:export
 *
 * Рабочие данные живут в `data/manual.db` вне git, и это правильно: деплой их
 * не трогает. Но и бэкапа у них тогда нет — эта команда выгружает базу в
 * закоммиченный файл-сид, чтобы историю можно было положить в репозиторий и
 * поднять из неё пустую установку.
 */
import { readShowcase, writeSeed } from '../src/lib/showcase-store';

readShowcase()
  .then((store) => {
    if (store.source !== 'db') {
      console.error(
        'Базы ручных данных нет — выгружать нечего. Запусти команду там, где радар пишет data/manual.db.',
      );
      process.exit(1);
    }

    const file = writeSeed(store);
    const days = Object.keys(store.days).length;
    const values = Object.values(store.days).reduce((n, d) => n + Object.keys(d).length, 0);

    console.log(`${file}: дней ${days}, значений ${values}`);
    console.log('Не забудь закоммитить файл — это и есть резервная копия.');
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
