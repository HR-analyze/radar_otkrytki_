// Прокладка для снимка: сборщик Next.js кладёт JSON в бандл как раньше, а TypeScript видит
// только объявление из snapshot-bundled.d.ts и не выводит тип из всего файла. На снимке
// в 20+ МБ вывод этого типа съедал больше 2 ГБ и валил сборку на шаге «Running TypeScript».
import snapshot from './snapshot.json';

export default snapshot;
