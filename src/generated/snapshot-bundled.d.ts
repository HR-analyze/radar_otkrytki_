// Тип снимка проверяется в src/lib/snapshot.ts (Snapshot); здесь — нарочно unknown,
// чтобы TypeScript не читал сам JSON (см. snapshot-bundled.js).
declare const snapshot: unknown;
export default snapshot;
