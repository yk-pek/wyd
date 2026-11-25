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
const COPY = {
  update: {
    title: 'What are you working on?',
    body: 'Tell people about it: what it is, where you are, what\'s next, where you\'re stuck…',
    button: 'Post',
  },
  idea: {
    title: 'What should someone build?',
    body: 'Describe the idea: the problem, who it\'s for, what a first version could look like…',
    button: 'Suggest it',
  },
};

function composer(kind = 'update') {
  const copy = COPY[kind];
  const title = h('input', { class: 'title-input', placeholder: copy.title, maxlength: LIMITS.title, 'aria-label': 'Title' });
  const body = h('textarea', { placeholder: copy.body, rows: 4, 'aria-label': 'Details' });
  const submit = h('button', { class: 'primary', type: 'submit' }, copy.button);
  const form = h('form', {
    class: 'card composer',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const { id } = await api('/api/posts', { method: 'POST', body: { kind, title: title.value, body: body.value } });
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

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function pills(p, showKind) {
  return [
    showKind && p.kind === 'idea' ? h('span', { class: 'pill idea' }, 'idea') : null,
    p.builder_count ? h('span', { class: 'pill build' }, `${p.builder_count} building`) : null,
    p.reply_count ? h('span', { class: 'pill' }, plural(p.reply_count, 'reply', 'replies')) : null,
  ];
}

// Upvote toggle for an idea. Updates itself in place.
function voteButton(p) {
  const n = h('span', { class: 'n' }, p.vote_count);
  const btn = h('button', {
    class: 'vote' + (p.voted ? ' on' : ''),
    title: p.voted ? 'Remove your vote' : 'Upvote: I want this to exist',
    'aria-pressed': String(!!p.voted),
    onclick: async (e) => {
      e.preventDefault();
      if (!state.user) return signIn();
      btn.disabled = true;
      try {
        await api(`/api/posts/${p.id}/vote`, { method: p.voted ? 'DELETE' : 'PUT' });
        p.vote_count += p.voted ? -1 : 1;
        p.voted = !p.voted;
        n.textContent = p.vote_count;
        btn.classList.toggle('on', p.voted);
        btn.setAttribute('aria-pressed', String(p.voted));
      } catch (err) { toast(err.message); }
      btn.disabled = false;
    },
  }, h('span', { class: 'arrow' }, '▲'), n);
  return btn;
}

function postCard(p, { showKind = false } = {}) {
  const link = h('a', { href: `#/p/${p.id}`, class: 'card post-link' },
    h('h2', { class: 'post-title' }, p.title),
    byline(p.author, p.author_name, p.created_at, pills(p, showKind)),
    h('p', { class: 'excerpt' }, p.excerpt + (p.truncated ? '…' : ''))
  );
  if (p.kind !== 'idea' || showKind) return link;
  return h('div', { class: 'card idea-card' }, voteButton(p), link);
}

function feed(query, emptyText, cardOptions) {
  const list = h('div', { class: 'stack' });
  const more = h('button', { class: 'more' }, 'Load more');
  let before = null;
  let offset = 0;
  async function load() {
    more.disabled = true;
    try {
      const qs = new URLSearchParams(query);
      if (query.sort === 'top') qs.set('offset', offset);
      else if (before) qs.set('before', before);
      const { posts, more: hasMore } = await api(`/api/posts?${qs}`);
      if (!before && !offset && !posts.length) list.append(h('p', { class: 'empty' }, emptyText));
      posts.forEach((p) => list.append(postCard(p, cardOptions)));
      if (posts.length) before = posts[posts.length - 1].id;
      offset += posts.length;
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
    state.user ? composer('update') : welcome(),
    feed({ kind: 'update' }, 'Nothing here yet. Be the first to say what you\'re working on.')
  );
}

function ideasView(sort) {
  return h('div', { class: 'stack' },
    state.user ? composer('idea') : h('section', { class: 'card welcome' },
      h('h1', null, 'Ideas to build'),
      h('p', null, 'Things people wish existed. Upvote the ones you want, or pick one up and build it. Connect a wallet to suggest an idea.'),
      h('button', { class: 'primary', onclick: signIn }, 'Connect wallet')),
    h('div', { class: 'section-head' },
      h('p', null, 'Upvote what you want to exist. Pick one up and run with it.'),
      h('div', { class: 'seg', role: 'tablist' },
        h('a', { href: '#/ideas', class: sort === 'top' ? 'active' : '' }, 'Top'),
        h('a', { href: '#/ideas/new', class: sort === 'new' ? 'active' : '' }, 'New'))),
    feed({ kind: 'idea', sort }, 'No ideas yet. Suggest something you wish someone would build.')
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

  const isIdea = post.kind === 'idea';
  const home = isIdea ? '#/ideas' : '#/';

  let ideaPanel = null;
  if (isIdea) {
    const buildBtn = h('button', {
      class: 'build-btn' + (post.building ? ' on' : ''),
      onclick: async () => {
        if (!state.user) return signIn();
        buildBtn.disabled = true;
        try {
          await api(`/api/posts/${post.id}/build`, { method: post.building ? 'DELETE' : 'PUT' });
          toast(post.building ? 'You\'re no longer listed as building this' : 'You\'re building this. Post an update when you have something to show!');
          route();
        } catch (e) { toast(e.message); buildBtn.disabled = false; }
      },
    }, post.building ? '✓ You\'re building this' : '🛠 I\'m building this');

    ideaPanel = h('div', null,
      h('div', { class: 'actions' }, voteButton(post), buildBtn),
      post.building ? h('p', { class: 'hint' }, 'Click again to step back. Share progress under "What people are doing".') : null,
      h('div', { class: 'builders' },
        h('h4', null, post.builders.length ? `Being built by ${plural(post.builders.length, 'person', 'people')}` : 'Nobody has picked this up yet'),
        post.builders.length
          ? h('ul', null, post.builders.map((b) => h('li', null,
              h('a', { href: `#/u/${b.address}` }, dot(b.address), nameOf(b.address, b.name)))))
          : h('p', { class: 'hint', style: 'margin:0' }, 'Want to run with it? Click "I\'m building this" so others know.'))
    );
  }

  return h('div', { 'data-kind': post.kind },
    h('a', { href: home, class: 'back' }, isIdea ? '← All ideas' : '← All posts'),
    h('article', { class: 'card' },
      h('h1', { class: 'post-title', style: 'font-size:24px' }, post.title),
      byline(post.author, post.author_name, post.created_at, [
        isIdea ? h('span', { class: 'pill idea' }, 'idea') : null,
        mine ? h('button', { class: 'link danger', onclick: async () => {
          if (!confirm(`Delete this ${isIdea ? 'idea' : 'post'} and its replies?`)) return;
          try { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); location.hash = home; } catch (e) { toast(e.message); }
        } }, 'delete') : null,
      ]),
      h('p', { class: 'body' }, post.body),
      ideaPanel
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
    h('div', { class: 'stack' }, head, feed({ author: address }, mine ? 'You haven\'t posted yet.' : 'No posts yet.', { showKind: true }))
  );
}

// ---------- router ----------
async function route() {
  document.title = 'wyd';
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  const setTab = (tab) => document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  try {
    let node;
    if ((m = hash.match(/^\/p\/(\d+)$/))) {
      node = await postView(m[1]);
      setTab(node.dataset.kind === 'idea' ? 'ideas' : 'updates');
    } else if ((m = hash.match(/^\/u\/(0x[0-9a-fA-F]{40})$/))) {
      node = profileView(m[1]);
      setTab(null);
    } else if ((m = hash.match(/^\/ideas(?:\/(new))?$/))) {
      node = ideasView(m[1] ? 'new' : 'top');
      setTab('ideas');
      document.title = 'Ideas · wyd';
    } else {
      node = homeView();
      setTab('updates');
    }
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
