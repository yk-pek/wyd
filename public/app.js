'use strict';

const state = { user: null };
const LIMITS = { title: 120, body: 5000, reply: 2000, name: 32 };

// ---------- tiny DOM helper (never uses innerHTML for user content) ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $view = document.getElementById('view');
const $account = document.getElementById('account');

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- formatting ----------
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nameOf = (address, name) => name || shortAddr(address);
const hue = (a) => parseInt(a.slice(2, 8), 16) % 360;
const dot = (a) => h('span', { class: 'dot', style: `background: linear-gradient(135deg, hsl(${hue(a)} 80% 60%), hsl(${(hue(a) + 60) % 360} 80% 50%))` });

function ago(iso) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso)) / 1000));
  const units = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return 'just now';
}

function byline(address, name, createdAt, extra) {
  return h('div', { class: 'meta' },
    dot(address),
    h('a', { href: `#/u/${address}`, class: 'author' }, nameOf(address, name)),
    name ? h('span', { class: 'addr' }, shortAddr(address)) : null,
    h('span', null, '·'),
    h('time', { datetime: createdAt, title: new Date(createdAt).toLocaleString() }, ago(createdAt)),
    extra
  );
}

function counted(field, max) {
  const counter = h('span', { class: 'counter' }, `0/${max}`);
  const update = () => {
    counter.textContent = `${field.value.length}/${max}`;
    counter.style.color = field.value.length > max ? 'var(--danger)' : '';
  };
  field.addEventListener('input', update);
  return counter;
}

// ---------- wallet sign-in ----------
function toHex(str) {
  return '0x' + Array.from(new TextEncoder().encode(str), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signIn() {
  if (!window.ethereum) {
    toast('No wallet found. Install a browser wallet like MetaMask or Rabby, then reload.');
    return;
  }
  try {
    const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!address) throw new Error('No account selected');
    const { nonce, message } = await api('/api/auth/nonce', { method: 'POST', body: { address } });
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [toHex(message), address] });
    const { user } = await api('/api/auth/verify', { method: 'POST', body: { nonce, signature } });
    state.user = user;
    renderAccount();
    route();
    toast('Signed in');
  } catch (err) {
    if (err && err.code === 4001) toast('Sign-in cancelled');
    else toast(err.message || 'Sign-in failed');
  }
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  renderAccount();
  route();
}

function renderAccount() {
  $account.replaceChildren();
  if (state.user) {
    const u = state.user;
    $account.append(
      h('a', { href: `#/u/${u.address}`, class: 'chip', style: 'text-decoration:none' }, dot(u.address), h('span', null, nameOf(u.address, u.display_name))),
      h('button', { class: 'link', onclick: signOut }, 'Sign out')
    );
  } else {
    $account.append(h('button', { class: 'primary', onclick: signIn }, 'Connect wallet'));
  }
}

// ---------- views ----------
function composer() {
  const title = h('input', { class: 'title-input', placeholder: 'What are you working on?', maxlength: LIMITS.title, 'aria-label': 'Title' });
  const body = h('textarea', { placeholder: 'Tell people about it: what it is, where you are, what\'s next, where you\'re stuck…', rows: 4, 'aria-label': 'Details' });
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Post');
  const form = h('form', {
    class: 'card composer',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { id } = await api('/api/posts', { method: 'POST', body: { title: title.value, body: body.value } });
        location.hash = `#/p/${id}`;
      } catch (err) {
        toast(err.message);
      } finally {
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'stack' }, title, body, h('div', { class: 'row' }, counted(body, LIMITS.body), submit))
  );
  return form;
}

function welcome() {
  return h('section', { class: 'card welcome' },
    h('h1', null, 'wyd?'),
    h('p', null, 'A place to share what you\'re building and see what everyone else is up to. Connect a wallet to post. It\'s just a signature: no gas, no transaction.'),
    h('button', { class: 'primary', onclick: signIn }, 'Connect wallet')
  );
}

function postCard(p) {
  return h('a', { href: `#/p/${p.id}`, class: 'card post-link' },
    h('h2', { class: 'post-title' }, p.title),
    byline(p.author, p.author_name, p.created_at,
      p.reply_count ? h('span', { class: 'pill' }, `${p.reply_count} ${p.reply_count === 1 ? 'reply' : 'replies'}`) : null),
    h('p', { class: 'excerpt' }, p.excerpt + (p.truncated ? '…' : ''))
  );
}

function feed(query, emptyText) {
  const list = h('div', { class: 'stack' });
  const more = h('button', { class: 'more' }, 'Load more');
  let before = null;
  async function load() {
    more.disabled = true;
    try {
      const qs = new URLSearchParams(query);
      if (before) qs.set('before', before);
      const { posts, more: hasMore } = await api(`/api/posts?${qs}`);
      if (!before && !posts.length) list.append(h('p', { class: 'empty' }, emptyText));
      posts.forEach((p) => list.append(postCard(p)));
      if (posts.length) before = posts[posts.length - 1].id;
      more.hidden = !hasMore;
    } catch (err) {
      toast(err.message);
    } finally {
      more.disabled = false;
    }
  }
  more.addEventListener('click', load);
  more.hidden = true;
  load();
  return h('div', null, list, more);
}

function homeView() {
  return h('div', { class: 'stack' },
    state.user ? composer() : welcome(),
    feed({}, 'Nothing here yet. Be the first to say what you\'re working on.')
  );
}

async function postView(id) {
  const { post, replies } = await api(`/api/posts/${encodeURIComponent(id)}`);
  document.title = `${post.title} · wyd`;
  const mine = state.user && state.user.address === post.author;

  const replyList = h('div', { class: 'stack' },
    replies.length ? replies.map((r) => h('div', { class: 'reply' },
      byline(r.author, r.author_name, r.created_at,
        state.user && state.user.address === r.author
          ? h('button', { class: 'link danger', onclick: async () => {
              if (!confirm('Delete this reply?')) return;
              try { await api(`/api/replies/${r.id}`, { method: 'DELETE' }); route(); } catch (e) { toast(e.message); }
            } }, 'delete')
          : null),
      h('p', null, r.body)
    )) : h('p', { class: 'meta' }, 'No replies yet.')
  );

  let replyBox;
  if (state.user) {
    const text = h('textarea', { placeholder: 'Write a reply…', rows: 3, 'aria-label': 'Reply' });
    const send = h('button', { class: 'primary', type: 'submit' }, 'Reply');
    replyBox = h('form', {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        send.disabled = true;
        try {
          await api(`/api/posts/${post.id}/replies`, { method: 'POST', body: { body: text.value } });
          route();
        } catch (err) {
          toast(err.message);
          send.disabled = false;
        }
      },
    }, text, h('div', { class: 'row' }, counted(text, LIMITS.reply), send));
  } else {
    replyBox = h('div', { class: 'card row' }, h('span', { class: 'meta' }, 'Connect a wallet to reply.'), h('button', { class: 'primary', onclick: signIn }, 'Connect wallet'));
  }

  return h('div', null,
    h('a', { href: '#/', class: 'back' }, '← All posts'),
    h('article', { class: 'card' },
      h('h1', { class: 'post-title', style: 'font-size:24px' }, post.title),
      byline(post.author, post.author_name, post.created_at,
        mine ? h('button', { class: 'link danger', onclick: async () => {
          if (!confirm('Delete this post and its replies?')) return;
          try { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); location.hash = '#/'; } catch (e) { toast(e.message); }
        } }, 'delete') : null),
      h('p', { class: 'body' }, post.body)
    ),
    h('section', { class: 'replies' }, h('h3', null, `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`), replyList),
    h('div', { style: 'margin-top:16px' }, replyBox)
  );
}

function profileView(address) {
  address = address.toLowerCase();
  const mine = state.user && state.user.address === address;
  const head = h('div', { class: 'card profile-head stack' });

  if (mine) {
    const input = h('input', { value: state.user.display_name || '', placeholder: 'Display name (optional)', maxlength: LIMITS.name, 'aria-label': 'Display name' });
    const save = h('button', { class: 'primary', type: 'submit' }, 'Save');
    head.append(
      h('div', { class: 'chip' }, dot(address), h('span', { class: 'addr' }, address)),
      h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          const { user } = await api('/api/me', { method: 'PUT', body: { display_name: input.value } });
          state.user = user;
          renderAccount();
          toast('Saved');
        } catch (err) { toast(err.message); }
        save.disabled = false;
      } }, input, save)
    );
  } else {
    head.append(h('div', { class: 'chip' }, dot(address), h('h1', { class: 'addr', style: 'font-size:15px' }, address)));
  }

  return h('div', null,
    h('a', { href: '#/', class: 'back' }, '← All posts'),
    h('div', { class: 'stack' }, head, feed({ author: address }, mine ? 'You haven\'t posted yet.' : 'No posts yet.'))
  );
}

// ---------- router ----------
async function route() {
  document.title = 'wyd';
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  try {
    let node;
    if ((m = hash.match(/^\/p\/(\d+)$/))) node = await postView(m[1]);
    else if ((m = hash.match(/^\/u\/(0x[0-9a-fA-F]{40})$/))) node = profileView(m[1]);
    else node = homeView();
    $view.replaceChildren(node);
  } catch (err) {
    $view.replaceChildren(h('div', null, h('a', { href: '#/', class: 'back' }, '← All posts'), h('p', { class: 'empty' }, err.message)));
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
if (window.ethereum && window.ethereum.on) {
  window.ethereum.on('accountsChanged', (accounts) => {
    if (state.user && (!accounts[0] || accounts[0].toLowerCase() !== state.user.address)) signOut();
  });
}

(async () => {
  try { state.user = (await api('/api/me')).user; } catch { state.user = null; }
  renderAccount();
  route();
})();
