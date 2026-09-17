'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ContestViolation } from '@/lib/contest-violations-store';
import type { ShopRow } from '@/lib/queries';

export function ContestViolations({ violations, shops, editable, unlocked, tokenRequired, returnTo }: {
  violations: ContestViolation[];
  shops: ShopRow[];
  editable: boolean;
  unlocked: boolean;
  tokenRequired: boolean;
  returnTo: string;
}) {
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const [shopCode, setShopCode] = useState('');
  const [reason, setReason] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selected = shops.find((s) => s.code === shopCode);

  async function send(method: 'POST' | 'DELETE', id?: string) {
    setBusy(true);
    setMessage('');
    try {
      if (method === 'POST' && !requestId.current) {
        // getRandomValues доступен и на HTTP внутри локальной сети.
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        requestId.current = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      const res = await fetch(`/api/contest/violations${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-radar-upload-token': token },
        body: method === 'POST' ? JSON.stringify({ id: requestId.current, shopCode, reason }) : undefined,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Не удалось сохранить.');
      if (method === 'POST') {
        setReason('');
        requestId.current = null;
      }
      setMessage(method === 'POST' ? 'Нарушение сохранено: −1 у лавки и её РМ.' : 'Ошибочная запись удалена, балл восстановлен.');
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Ошибка сети. Повторите отправку.');
    } finally { setBusy(false); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send('POST');
  }

  return (
    <section className="surface p-4">
      <h2 className="text-sm font-semibold">Нарушения конкурса</h2>
      <p className="mt-1 text-xs muted">
        Каждая запись — постоянный −1 к итогу лавки и её РМ. Смена периода не снимает штраф.
        РМ закрепляется при внесении. В сумме сети штраф учитывается один раз.
      </p>
      {violations.length === 0 ? <p className="mt-3 text-sm muted">По выбранным фильтрам нарушений нет.</p> : (
        <ul className="mt-3 space-y-2 text-sm">
          {violations.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2" style={{ borderColor: 'var(--border)' }}>
              <span><strong>{v.shopCode} · −1</strong> · РМ {v.region} · {v.reason}{v.fixed && ' · закреплён'}</span>
              {!v.fixed && editable && unlocked && <button type="button" className="text-xs underline" disabled={busy}
                onClick={() => { if (window.confirm('Удалить ошибочную запись и вернуть балл?')) void send('DELETE', v.id); }}>
                Удалить ошибочную запись
              </button>}
            </li>
          ))}
        </ul>
      )}
      {!unlocked ? <a className="mt-3 inline-block text-sm underline" href={`/login?next=${encodeURIComponent(returnTo)}`}>Войти для внесения нарушений</a>
        : !editable ? <p className="mt-3 text-xs muted">Здесь доступен просмотр нарушений. Для внесения откройте радар на сервере с сохранением данных.</p>
        : <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
          <fieldset disabled={busy} className="contents">
            <label className="flex flex-col gap-1 text-xs">Лавка
              <select required value={shopCode} onChange={(e) => { setShopCode(e.target.value); requestId.current = null; }} className="rounded border p-2 text-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <option value="">Выберите лавку</option>
                {shops.filter((s) => s.region).map((s) => <option key={s.code} value={s.code}>{s.name} · {s.region}</option>)}
              </select>
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">Причина нарушения
              <input required maxLength={300} value={reason} onChange={(e) => { setReason(e.target.value); requestId.current = null; }} className="rounded border p-2 text-sm" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }} />
            </label>
            {tokenRequired && <label className="flex flex-col gap-1 text-xs">Код загрузки
              <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="rounded border p-2 text-sm" />
            </label>}
            <button type="submit" disabled={!reason.trim() || !selected?.region} className="rounded border px-3 py-2 text-sm font-medium disabled:opacity-50" style={{ borderColor: 'var(--border)' }}>
              {busy ? 'Сохранение…' : 'Внести нарушение · −1'}
            </button>
          </fieldset>
        </form>}
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    </section>
  );
}
