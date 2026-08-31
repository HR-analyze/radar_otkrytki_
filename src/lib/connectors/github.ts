import { isSupersededBy } from '../uploads';

/**
 * Коммит выгрузок в репозиторий — способ «положить файл в fixtures/» там, где
 * диска нет.
 *
 * На Vercel файловая система только для чтения, поэтому загруженный с дашборда
 * файл сохранить некуда: следующий же запрос попадёт в другой инстанс, где его
 * нет. Зато репозиторий — уже действующий источник данных: снимок печётся из
 * `fixtures/` при сборке. Значит кнопка «Загрузить» делает ровно то, что до неё
 * делали руками (`git add fixtures && git commit && git push`), а деплой по
 * пушу пересобирает снимок. См. README, «Загрузка файлов с дашборда».
 */

export interface GithubTarget {
  owner: string;
  repo: string;
  branch: string;
  /** Папка в репозитории, куда кладутся выгрузки. */
  dir: string;
  token: string;
}

export interface CommitResult {
  sha: string;
  url: string;
  /** Имена файлов, удалённых как замещённые (то же имя, другое расширение). */
  removed: string[];
}

const API = 'https://api.github.com';

/**
 * Owner, repo и ветку на Vercel подставлять не надо: их деплой сам кладёт в
 * окружение. Настроить остаётся один токен.
 */
export function githubTargetFromEnv(
  env: Record<string, string | undefined> = process.env,
): GithubTarget | null {
  const token = env.RADAR_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (!token) return null;

  const [repoOwner, repoName] = (env.RADAR_GITHUB_REPO ?? '').split('/');
  const owner = repoOwner || env.VERCEL_GIT_REPO_OWNER;
  const repo = repoName || env.VERCEL_GIT_REPO_SLUG;
  if (!owner || !repo) return null;

  return {
    owner,
    repo,
    branch: env.RADAR_GITHUB_BRANCH || env.VERCEL_GIT_COMMIT_REF || 'main',
    dir: env.RADAR_GITHUB_FIXTURES_DIR || 'fixtures',
    token,
  };
}

/**
 * Кладёт файлы одним коммитом через Git Data API.
 *
 * Одним, а не по файлу: «выходы» и «водители» за день загружают вместе, а
 * каждый коммит — это отдельная пересборка на Vercel.
 *
 * Файл с тем же каноническим именем перезаписывается. Файл с тем же именем, но
 * другим расширением (`vitriny.xls` при загруженной `vitriny.xlsx`) удаляется:
 * иначе в папке окажутся две легаси-книги, и `readFixtures` молча возьмёт не ту.
 */
export async function commitFixtures(
  target: GithubTarget,
  files: readonly { name: string; buffer: Buffer }[],
  message: string,
): Promise<CommitResult> {
  if (files.length === 0) throw new Error('Нечего коммитить');

  const ref = await api<{ object: { sha: string } }>(
    target,
    `/git/ref/heads/${encodeURIComponent(target.branch)}`,
  );
  const baseCommit = await api<{ tree: { sha: string } }>(target, `/git/commits/${ref.object.sha}`);

  const tree: TreeEntry[] = [];
  for (const file of files) {
    const blob = await api<{ sha: string }>(target, '/git/blobs', {
      method: 'POST',
      body: { content: file.buffer.toString('base64'), encoding: 'base64' },
    });
    tree.push({ path: `${target.dir}/${file.name}`, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const removed: string[] = [];
  for (const existing of await listFixtures(target)) {
    if (files.some((f) => isSupersededBy(existing, f.name))) {
      // sha: null — так Git Data API удаляет файл из дерева.
      tree.push({ path: `${target.dir}/${existing}`, mode: '100644', type: 'blob', sha: null });
      removed.push(existing);
    }
  }

  const newTree = await api<{ sha: string }>(target, '/git/trees', {
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree },
  });
  const commit = await api<{ sha: string; html_url: string }>(target, '/git/commits', {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [ref.object.sha] },
  });

  await api(target, `/git/refs/heads/${encodeURIComponent(target.branch)}`, {
    method: 'PATCH',
    body: { sha: commit.sha },
  });

  return { sha: commit.sha, url: commit.html_url, removed };
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null;
}

/** Имена файлов в папке выгрузок. Пустой папки ещё нет — это не ошибка. */
async function listFixtures(target: GithubTarget): Promise<string[]> {
  try {
    const items = await api<{ name: string; type: string }[]>(
      target,
      `/contents/${encodePath(target.dir)}?ref=${encodeURIComponent(target.branch)}`,
    );
    return items.filter((i) => i.type === 'file').map((i) => i.name);
  } catch {
    return [];
  }
}

/** Путь кодируется посегментно: слэш в имени папки — разделитель, а не символ. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function api<T>(
  target: GithubTarget,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API}/repos/${target.owner}/${target.repo}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${target.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'radar-otkrytki',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(await describeFailure(res, target));
  return (await res.json()) as T;
}

/** Ошибки GitHub переводятся в то, что человеку делать: чинить их будет он. */
async function describeFailure(res: Response, target: GithubTarget): Promise<string> {
  const where = `${target.owner}/${target.repo}@${target.branch}`;
  const detail = await res.text().then(
    (t) => {
      try {
        return (JSON.parse(t) as { message?: string }).message ?? '';
      } catch {
        return t.slice(0, 200);
      }
    },
    () => '',
  );

  if (res.status === 401 || res.status === 403) {
    return (
      `GitHub не принял токен (${res.status}). Нужен токен с правом ` +
      `Contents: Read and write на ${where}. ${detail}`.trim()
    );
  }
  if (res.status === 404) {
    return `GitHub не нашёл ${where} — проверьте репозиторий, ветку и доступ токена. ${detail}`.trim();
  }
  if (res.status === 409 || res.status === 422) {
    return `В ветку ${where} параллельно запушили что-то ещё. Повторите загрузку. ${detail}`.trim();
  }
  return `GitHub ответил ${res.status}. ${detail}`.trim();
}
