// GitHub Contents API로 저장소의 JSON 파일을 읽고 쓴다. (서버 없이 브라우저에서 직접 호출)
const API = 'https://api.github.com';

function headers(cfg, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function contentsUrl(cfg, path) {
  return `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(path)}`;
}

async function fail(res) {
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.message ? `GitHub: ${data.message} (${res.status})` : `GitHub 오류 (${res.status})`);
  err.status = res.status;
  throw err;
}

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 파일이 없으면 null, 있으면 { json, sha } */
export async function getFile(cfg, path) {
  const url = `${contentsUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, { headers: headers(cfg), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) await fail(res);
  const meta = await res.json();
  let text;
  if (meta.content) {
    text = b64decode(meta.content);
  } else {
    // 1MB 초과 파일은 content가 비어 있으므로 raw로 다시 받는다
    const raw = await fetch(url, { headers: headers(cfg, 'application/vnd.github.raw+json'), cache: 'no-store' });
    if (!raw.ok) await fail(raw);
    text = await raw.text();
  }
  return { json: text.trim() ? JSON.parse(text) : null, sha: meta.sha };
}

/** 파일을 생성/수정하고 새 sha를 돌려준다 */
export async function putFile(cfg, path, text, sha, message) {
  const body = { message, content: b64encode(text), branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await fetch(contentsUrl(cfg, path), {
    method: 'PUT',
    headers: { ...headers(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res);
  const data = await res.json();
  return data.content.sha;
}

export async function testConnection(cfg) {
  const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}`, { headers: headers(cfg) });
  if (!res.ok) await fail(res);
  const repo = await res.json();
  const br = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`, { headers: headers(cfg) });
  if (!br.ok) await fail(br);
  return { fullName: repo.full_name, private: repo.private, canPush: !!repo.permissions?.push };
}
