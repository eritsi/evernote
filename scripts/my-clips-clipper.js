// ==UserScript==
// @name         My Clips Clipper
// @namespace    https://github.com/
// @version      1.0.0
// @description  レシピ・ウェブページをGitHubリポに保存するクリッパー
// @match        https://*/*
// @match        http://*/*
// @exclude      https://finance.yahoo.co.jp/*
// @exclude      https://raw.githubusercontent.com/*
// @exclude      https://github.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 設定ヘルパー ────────────────────────────────────────
  const cfg = {
    get: (k, d) => GM_getValue('myclips_' + k, d),
    set: (k, v) => GM_setValue('myclips_' + k, v),
  };

  // ─── GitHub API ──────────────────────────────────────────
  const GH = {
    base: () => `https://api.github.com/repos/${cfg.get('owner')}/${cfg.get('repo')}/contents`,
    headers: () => ({
      'Authorization': `Bearer ${cfg.get('token')}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    }),

    // GET ファイル情報（SHA取得用）
    getFile(path) {
      return new Promise((res, rej) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `${GH.base()}/${encPath(path)}`,
          headers: GH.headers(),
          onload: r => res({ status: r.status, data: JSON.parse(r.responseText) }),
          onerror: rej,
        });
      });
    },

    // PUT テキストファイル（UTF-8）
    putText(path, text, message, sha) {
      const b64 = utfToB64(text);
      const body = { message, content: b64, branch: cfg.get('branch', 'main') };
      if (sha) body.sha = sha;
      return new Promise((res, rej) => {
        GM_xmlhttpRequest({
          method: 'PUT',
          url: `${GH.base()}/${encPath(path)}`,
          headers: GH.headers(),
          data: JSON.stringify(body),
          onload: r => res({ status: r.status, data: JSON.parse(r.responseText) }),
          onerror: rej,
        });
      });
    },

    // PUT バイナリ（base64文字列を直接渡す）
    putBinary(path, b64, message) {
      const body = { message, content: b64, branch: cfg.get('branch', 'main') };
      return new Promise((res, rej) => {
        GM_xmlhttpRequest({
          method: 'PUT',
          url: `${GH.base()}/${encPath(path)}`,
          headers: GH.headers(),
          data: JSON.stringify(body),
          onload: r => res({ status: r.status, data: JSON.parse(r.responseText) }),
          onerror: rej,
        });
      });
    },
  };

  // ─── ユーティリティ ──────────────────────────────────────
  function encPath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  function utfToB64(str) {
    // UTF-8テキスト → base64（btoa は ASCII のみのため変換が必要）
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  function slugify(text) {
    text = String(text || '').trim();
    text = text.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
    // バイト数80以下に切る
    let enc = new TextEncoder().encode(text);
    if (enc.length > 80) {
      text = new TextDecoder().decode(enc.slice(0, 80)).replace(/-+$/, '');
    }
    return text || 'untitled';
  }

  function isoNow() {
    return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  }

  function makePreview(md, len = 200) {
    return md.replace(/^#+\s+/gm, '').replace(/[!*_`[\]>]/g, '').replace(/\s+/g, ' ').trim().slice(0, len);
  }

  // ─── コンテンツ抽出 ──────────────────────────────────────

  // 1. JSON-LD Recipe スキーマを探す
  function extractJsonLdRecipe() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const raw = JSON.parse(script.textContent);
        const items = [raw].flat().concat(raw['@graph'] || []);
        const recipe = items.find(it => {
          const t = it['@type'];
          return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
        });
        if (recipe) return recipe;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  // 2. JSON-LD Recipe → Markdown 変換
  function recipeToMarkdown(r) {
    let md = '';
    if (r.description) md += `${r.description.trim()}\n\n`;

    // 調理情報
    const info = [];
    const toJp = s => s ? s.replace('PT', '').replace('H', '時間').replace('M', '分') : '';
    if (r.recipeYield)  info.push(`**分量**: ${[r.recipeYield].flat()[0]}`);
    if (r.totalTime)    info.push(`**合計**: ${toJp(r.totalTime)}`);
    if (r.prepTime)     info.push(`**下準備**: ${toJp(r.prepTime)}`);
    if (r.cookTime)     info.push(`**調理**: ${toJp(r.cookTime)}`);
    if (info.length)    md += info.join(' / ') + '\n\n';

    // 材料
    const ingredients = r.recipeIngredient || r.ingredients || [];
    if (ingredients.length) {
      md += '## 材料\n\n';
      ingredients.forEach(ing => { md += `- ${String(ing).trim()}\n`; });
      md += '\n';
    }

    // 手順
    const steps = r.recipeInstructions;
    if (steps) {
      md += '## 作り方\n\n';
      [steps].flat().forEach((step, i) => {
        const text = typeof step === 'string' ? step : (step.text || step.name || '');
        if (text.trim()) md += `${i + 1}. ${text.trim()}\n`;
      });
      md += '\n';
    }

    // 栄養情報（任意）
    if (r.nutrition) {
      const n = r.nutrition;
      const vals = [];
      if (n.calories)      vals.push(`カロリー: ${n.calories}`);
      if (n.proteinContent) vals.push(`タンパク質: ${n.proteinContent}`);
      if (vals.length) md += `> ${vals.join(' / ')}\n\n`;
    }

    return md;
  }

  // 3. 記事モード（簡易抽出）
  function extractArticle() {
    const SEL = ['article', '[class*="recipe"]', '[class*="entry-content"]',
                 '[class*="post-content"]', '[class*="article-body"]', 'main'];
    for (const s of SEL) {
      const el = document.querySelector(s);
      if (el && el.innerText.trim().length > 300) return el;
    }
    return document.body;
  }

  function domToMarkdown(el, depth = 0) {
    if (depth > 8) return '';
    let md = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { // TEXT_NODE
        const t = node.textContent.replace(/\s+/g, ' ');
        if (t.trim()) md += t;
      } else if (node.nodeType === 1) { // ELEMENT_NODE
        const tag = node.tagName.toLowerCase();
        if (['script','style','nav','header','footer','aside','iframe','noscript'].includes(tag)) continue;
        switch (tag) {
          case 'h1': md += `\n\n# ${node.innerText.trim()}\n\n`; break;
          case 'h2': md += `\n\n## ${node.innerText.trim()}\n\n`; break;
          case 'h3': md += `\n\n### ${node.innerText.trim()}\n\n`; break;
          case 'h4': case 'h5': case 'h6':
            md += `\n\n#### ${node.innerText.trim()}\n\n`; break;
          case 'p': {
            const t = node.innerText.trim();
            if (t) md += `\n${t}\n`;
            break;
          }
          case 'br': md += '\n'; break;
          case 'ul': {
            md += '\n';
            node.querySelectorAll(':scope > li').forEach(li => {
              md += `- ${li.innerText.trim()}\n`;
            });
            md += '\n';
            break;
          }
          case 'ol': {
            md += '\n';
            node.querySelectorAll(':scope > li').forEach((li, i) => {
              md += `${i + 1}. ${li.innerText.trim()}\n`;
            });
            md += '\n';
            break;
          }
          case 'blockquote':
            md += `\n> ${node.innerText.trim().replace(/\n/g, '\n> ')}\n\n`; break;
          case 'strong': case 'b': md += `**${node.innerText}**`; break;
          case 'em': case 'i': md += `_${node.innerText}_`; break;
          case 'a': md += node.innerText; break;
          case 'img': break; // 別途処理
          case 'table': {
            // テーブルは簡易テキスト化
            const rows = [...node.querySelectorAll('tr')].map(tr =>
              [...tr.querySelectorAll('th,td')].map(c => c.innerText.trim()).join(' : ')
            );
            md += '\n' + rows.join('\n') + '\n\n';
            break;
          }
          default: md += domToMarkdown(node, depth + 1);
        }
      }
    }
    return md;
  }

  // 4. ページ内の主要画像を収集（最大 MAX_IMGS 枚）
  const MAX_IMGS = 15;

  // imgタグから実際のsrcを取り出す（lazy-load各種に対応）
  function getRealSrc(img) {
    return img.getAttribute('data-src')
        || img.getAttribute('data-original')
        || img.getAttribute('data-lazy-src')
        || img.getAttribute('data-lazyload')
        || img.getAttribute('data-url')
        || img.getAttribute('data-lazy')
        || img.getAttribute('data-echo')
        || img.getAttribute('data-image')
        || (() => {
             const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
             const u = ss.split(',')[0]?.trim().split(' ')[0];
             return u && !u.startsWith('data:') ? u : null;
           })()
        || (img.src && !img.src.startsWith('data:') ? img.src : null)
        || null;
  }

  // 広告スコアリング（0=コンテンツ確実、10=広告確実）
  function calcAdScore(imgEl, url) {
    let score = 0;
    // 1. 親要素のクラス/IDが広告っぽい
    const adParent = imgEl.closest(
      '[class*="ad-"],[class*="-ad"],[class*="ads"],[id*="ad-"],[id*="-ad"],' +
      '[class*="banner"],[class*="sponsor"],[class*="affiliate"],[class*="promo"],' +
      '[class*="adsense"],[data-ad],[data-dfp],[class*="advertisement"],' +
      '[class*="related"],[class*="recommend"],[class*="widget"]'
    );
    if (adParent) score += 5;

    // 2. URLに広告ネットワーク・トラッキング系のキーワード
    if (/doubleclick|googlesyndication|amazon-adsystem|adserver|adnxs|criteo|taboola|outbrain|revcontent|adsystem|ad\.jp|yimg\.jp.*ad/i.test(url)) score += 8;

    // 3. URLにアイコン・ロゴ系キーワード
    if (/\/icon|\/logo|\/avatar|social|share|badge|button|\.ico($|\?)/i.test(url)) score += 4;

    // 4. バナー的なアスペクト比（横長＝728x90等、縦長細い＝160x600等）
    const w = imgEl.naturalWidth  || parseInt(imgEl.getAttribute('width')  || '0');
    const h = imgEl.naturalHeight || parseInt(imgEl.getAttribute('height') || '0');
    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (ratio > 5 || ratio < 0.2) score += 4;   // 極端な縦横比
    }

    // 5. 極小画像（1x1トラッキングピクセルなど）
    if (w > 0 && h > 0 && w < 50 && h < 50) score += 6;

    return Math.min(score, 10);
  }

  // 候補画像を収集して {url, adScore} のリストを返す
  function collectImages(jsonLdRecipe) {
    const seen = new Set();
    const candidates = [];  // {url, adScore}

    const addUrl = (url, score = 0) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      candidates.push({ url, adScore: score });
    };

    if (jsonLdRecipe) {
      // ① 完成写真：同じ写真のアスペクト比バリアント配列なので最初の1枚だけ
      const mainImgs = [jsonLdRecipe.image].flat().filter(Boolean);
      if (mainImgs.length > 0) {
        const first = mainImgs[0];
        const u = typeof first === 'string' ? first : (first.url || first.contentUrl);
        addUrl(u, 0);
      }

      // ② 手順写真：recipeInstructions[i].image
      const allSteps = [jsonLdRecipe.recipeInstructions].flat().filter(Boolean);
      allSteps.forEach(step => {
        const items = step['@type'] === 'HowToSection'
          ? [step.itemListElement].flat().filter(Boolean)
          : [step];
        items.forEach(s => {
          [s.image].flat().filter(Boolean).forEach(img => {
            const u = typeof img === 'string' ? img : (img.url || img.contentUrl);
            addUrl(u, 0);
          });
        });
      });
    }

    // ③ DOMから全画像を収集（JSON-LDの補完 or フォールバック）
    const contentEl = extractArticle();
    contentEl.querySelectorAll('img').forEach(imgEl => {
      const url = getRealSrc(imgEl);
      if (!url || seen.has(url)) return;
      const w = imgEl.naturalWidth  || parseInt(imgEl.getAttribute('width')  || '0');
      const h = imgEl.naturalHeight || parseInt(imgEl.getAttribute('height') || '0');
      // 極小（50px未満）は最初から除外
      if (w > 0 && h > 0 && w < 50 && h < 50) return;
      // サイズ不明(lazy)か200px以上のものを候補に
      if ((w === 0 && h === 0) || w >= 200 || h >= 150) {
        addUrl(url, calcAdScore(imgEl, url));
      }
    });

    // adScore でソート（0が先頭＝コンテンツ写真優先）して上限枚数に絞る
    candidates.sort((a, b) => a.adScore - b.adScore);
    return candidates.slice(0, MAX_IMGS);
  }

  // 5. GM_xmlhttpRequest で画像を base64 取得
  function fetchImageB64(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 15000,
        onload: r => {
          const reader = new FileReader();
          reader.onload = () => resolve({ ok: true, b64: reader.result.split(',')[1], mime: r.finalUrl ? '' : '' });
          reader.onerror = () => resolve({ ok: false });
          reader.readAsDataURL(r.response);
        },
        onerror: () => resolve({ ok: false }),
        ontimeout: () => resolve({ ok: false }),
      });
    });
  }

  function imgExt(url) {
    const m = url.match(/\.(jpe?g|png|gif|webp|svg)(\?|$)/i);
    return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.jpg';
  }

  // ─── Markdown / Frontmatter 生成 ─────────────────────────
  function buildNote({ title, notebook, tags, sourceUrl, body, images, memo }) {
    const now = isoNow();
    const tagYaml = tags.length ? `[${tags.map(t => `"${t}"`).join(', ')}]` : '[]';
    const fm = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `created: ${now}`,
      `updated: ${now}`,
      `notebook: "${notebook}"`,
      `tags: ${tagYaml}`,
      sourceUrl ? `source_url: "${sourceUrl}"` : '',
      '---',
    ].filter(Boolean).join('\n');

    // 画像参照を本文の先頭に挿入
    let imgMd = '';
    images.forEach((img, i) => {
      const encodedName = encodeURIComponent(img.filename);
      imgMd += `\n![${img.filename}](./images/${encodedName})\n`;
    });

    let fullBody = body;
    if (memo && memo.trim()) {
      fullBody += `\n\n---\n\n## メモ\n\n${memo.trim()}\n`;
    }
    if (imgMd) fullBody += '\n' + imgMd;

    return `${fm}\n\n# ${title}\n\n${fullBody.trim()}\n`;
  }

  // ─── 検索インデックス更新 ────────────────────────────────
  async function updateSearchIndex(newNote) {
    const indexPath = 'search-index.json';
    let existing = { count: 0, notes: [] };
    let sha = null;

    try {
      const r = await GH.getFile(indexPath);
      if (r.status === 200) {
        sha = r.data.sha;
        const decoded = atob(r.data.content.replace(/\n/g, ''));
        existing = JSON.parse(new TextDecoder().decode(
          Uint8Array.from(decoded, c => c.charCodeAt(0))
        ));
      }
    } catch (e) { /* 新規作成 */ }

    // 同じIDがあれば更新、なければ追加
    const idx = existing.notes.findIndex(n => n.id === newNote.id);
    if (idx >= 0) existing.notes[idx] = newNote;
    else existing.notes.unshift(newNote);
    existing.count = existing.notes.length;
    existing.generated = isoNow();

    await GH.putText(
      indexPath,
      JSON.stringify(existing, null, 2),
      `Update search-index: ${newNote.title}`,
      sha
    );
  }

  // ─── メイン保存フロー ────────────────────────────────────
  async function saveNote(formData, setStatus) {
    const { title, notebook, tags, memo } = formData;
    const slug = slugify(title);
    const noteDir = `notes/${notebook}/${slug}`;
    const notePath = `${noteDir}/note.md`;
    const sourceUrl = location.href;

    setStatus('loading', '画像を取得中…');

    // selectedUrls: ユーザーが選択した画像URLリスト
    const imgUrls = formData.selectedUrls || [];
    const savedImages = [];

    for (let i = 0; i < imgUrls.length; i++) {
      const url = imgUrls[i];
      const ext = imgExt(url);
      const filename = `${String(i + 1).padStart(3, '0')}${ext}`;
      const result = await fetchImageB64(url);
      if (result.ok) {
        savedImages.push({ filename, b64: result.b64, url });
      }
    }

    setStatus('loading', `画像 ${savedImages.length} 枚を保存中…`);

    // 画像をGitHubへ
    for (const img of savedImages) {
      await GH.putBinary(
        `${noteDir}/images/${img.filename}`,
        img.b64,
        `Add image: ${img.filename} for ${title}`
      );
    }

    setStatus('loading', 'ノートを保存中…');

    // note.md
    const noteContent = buildNote({
      title, notebook,
      tags: tags.filter(Boolean),
      sourceUrl,
      body: formData._body,
      images: savedImages,
      memo,
    });

    await GH.putText(notePath, noteContent, `Add note: ${title}`);

    setStatus('loading', '検索インデックスを更新中…');

    // search-index.json 更新
    const preview = makePreview(formData._body);
    await updateSearchIndex({
      id: notePath,
      title,
      notebook,
      path: notePath,
      note_dir: noteDir,
      created: isoNow(),
      updated: isoNow(),
      tags: tags.filter(Boolean),
      source_url: sourceUrl,
      guid: '',
      preview,
      has_images: savedImages.length > 0,
      first_image: savedImages.length > 0 ? `${noteDir}/images/${savedImages[0].filename}` : '',
    });

    setStatus('success', `✅ 保存しました！\n${notebook} / ${slug}`);
  }

  // ─── UI ─────────────────────────────────────────────────
  const STYLE = `
    #mc-btn {
      position:fixed; bottom:24px; right:16px; z-index:2147483646;
      width:52px; height:52px; border-radius:50%;
      background:#B84C2A; color:#fff; border:none;
      font-size:22px; cursor:pointer; box-shadow:0 3px 12px rgba(0,0,0,.3);
      display:flex; align-items:center; justify-content:center;
      -webkit-tap-highlight-color:transparent;
    }
    #mc-overlay {
      position:fixed; inset:0; z-index:2147483647;
      background:rgba(0,0,0,.55); display:flex;
      align-items:flex-end; justify-content:center;
    }
    #mc-panel {
      background:#FAF7F2; border-radius:20px 20px 0 0;
      width:100%; max-width:680px; max-height:92dvh;
      overflow-y:auto; padding:20px 18px 32px;
      font-family:-apple-system,'Hiragino Sans',sans-serif;
      font-size:15px; color:#1C1C1E; box-sizing:border-box;
    }
    #mc-panel h2 { font-size:17px; margin:0 0 16px; }
    .mc-label { font-size:12px; color:#6B6B72; margin:12px 0 4px; }
    .mc-input, .mc-select, .mc-textarea {
      width:100%; padding:10px 12px; border-radius:10px;
      border:1.5px solid #E8E2D8; background:#fff;
      font-family:inherit; font-size:15px; color:#1C1C1E;
      box-sizing:border-box; outline:none;
    }
    .mc-input:focus, .mc-select:focus, .mc-textarea:focus {
      border-color:#B84C2A;
    }
    .mc-textarea { resize:vertical; min-height:72px; }
    .mc-badge {
      display:inline-flex; align-items:center; gap:4px;
      background:#F5E9E4; color:#B84C2A;
      font-size:12px; font-weight:500;
      padding:4px 10px; border-radius:20px; margin:4px 4px 0 0;
    }
    .mc-footer {
      display:flex; gap:10px; margin-top:20px;
    }
    .mc-btn-cancel {
      flex:1; padding:13px; border-radius:12px;
      border:1.5px solid #E8E2D8; background:#fff;
      font-family:inherit; font-size:15px; cursor:pointer;
      -webkit-tap-highlight-color:transparent;
    }
    .mc-btn-save {
      flex:2; padding:13px; border-radius:12px;
      border:none; background:#B84C2A; color:#fff;
      font-family:inherit; font-size:15px; font-weight:600;
      cursor:pointer; -webkit-tap-highlight-color:transparent;
    }
    .mc-btn-save:disabled { background:#ccc; }
    .mc-status {
      text-align:center; padding:20px 10px;
      font-size:14px; color:#6B6B72; line-height:1.6;
    }
    .mc-spinner {
      width:28px; height:28px;
      border:3px solid #E8E2D8; border-top-color:#B84C2A;
      border-radius:50%; animation:mc-spin .7s linear infinite;
      margin:0 auto 12px;
    }
    @keyframes mc-spin { to { transform:rotate(360deg); } }
    /* 設定パネル */
    .mc-settings-row { display:flex; gap:8px; margin-top:8px; }
    .mc-settings-row input {
      flex:1; padding:9px 11px; border-radius:10px;
      border:1.5px solid #E8E2D8; font-size:14px;
      font-family:inherit; box-sizing:border-box;
    }
    .mc-settings-row button {
      padding:9px 16px; border-radius:10px; border:none;
      background:#B84C2A; color:#fff; font-size:14px;
      font-family:inherit; cursor:pointer;
    }
    /* 画像グリッド */
    .mc-img-grid {
      display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-top:8px;
    }
    .mc-img-item {
      position:relative; aspect-ratio:1; border-radius:8px; overflow:hidden;
      cursor:pointer; border:2.5px solid transparent; transition:opacity .15s;
      -webkit-tap-highlight-color:transparent;
    }
    .mc-img-item.on  { border-color:#B84C2A; }
    .mc-img-item.off { opacity:.3; border-color:#ccc; }
    .mc-img-item img { width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
    .mc-img-chk {
      position:absolute; top:3px; right:3px;
      width:17px; height:17px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      font-size:10px; font-weight:700;
    }
    .mc-img-item.on  .mc-img-chk { background:#B84C2A; color:#fff; }
    .mc-img-item.off .mc-img-chk { background:#999; color:#fff; }
    .mc-img-count { font-size:12px; color:#6B6B72; margin-top:5px; }
  `;

  function injectStyle() {
    if (document.getElementById('mc-style')) return;
    const s = document.createElement('style');
    s.id = 'mc-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function removeOverlay() {
    document.getElementById('mc-overlay')?.remove();
  }

  // 設定UI（初回 or 設定変更時）
  function showSettingsUI() {
    removeOverlay();
    injectStyle();

    const overlay = document.createElement('div');
    overlay.id = 'mc-overlay';
    overlay.innerHTML = `
      <div id="mc-panel">
        <h2>⚙️ My Clips 設定</h2>
        <div class="mc-label">GitHub Personal Access Token（リポへの書き込み権限が必要）</div>
        <div class="mc-settings-row">
          <input id="mc-token" type="password" placeholder="ghp_xxxxx" value="${cfg.get('token', '')}">
        </div>
        <div class="mc-label">GitHubユーザー名</div>
        <div class="mc-settings-row">
          <input id="mc-owner" type="text" placeholder="eritsi" value="${cfg.get('owner', '')}">
        </div>
        <div class="mc-label">リポジトリ名</div>
        <div class="mc-settings-row">
          <input id="mc-repo" type="text" placeholder="evernote" value="${cfg.get('repo', '')}">
        </div>
        <div class="mc-label">ノートブック（1行1つ）</div>
        <textarea class="mc-textarea" id="mc-nbs" rows="5">${cfg.get('notebooks', 'レシピ\n中華レシピ\ntastytableレシピ\nル・クルーゼ\n宿\nストック')}</textarea>
        <div class="mc-label">デフォルトノートブック</div>
        <input class="mc-input" id="mc-default-nb" type="text" placeholder="レシピ" value="${cfg.get('default_notebook', 'ストック')}">
        <div class="mc-footer">
          <button class="mc-btn-cancel" id="mc-cancel-settings">閉じる</button>
          <button class="mc-btn-save" id="mc-save-settings">保存</button>
        </div>
      </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) removeOverlay(); });
    document.body.appendChild(overlay);

    document.getElementById('mc-cancel-settings').onclick = removeOverlay;
    document.getElementById('mc-save-settings').onclick = () => {
      cfg.set('token',            document.getElementById('mc-token').value.trim());
      cfg.set('owner',            document.getElementById('mc-owner').value.trim());
      cfg.set('repo',             document.getElementById('mc-repo').value.trim());
      cfg.set('notebooks',        document.getElementById('mc-nbs').value.trim());
      cfg.set('default_notebook', document.getElementById('mc-default-nb').value.trim());
      removeOverlay();
      alert('✅ 設定を保存しました');
    };
  }

  // メインクリップUI
  function showClipperUI() {
    if (!cfg.get('token') || !cfg.get('owner') || !cfg.get('repo')) {
      showSettingsUI();
      return;
    }

    removeOverlay();
    injectStyle();

    // コンテンツ抽出
    const recipe = extractJsonLdRecipe();
    const title  = recipe?.name?.trim() || document.title.split(/[|\-–—]/)[0].trim();
    const tags   = recipe ? ['レシピ'] : [];
    const body   = recipe ? recipeToMarkdown(recipe) : domToMarkdown(extractArticle()).replace(/\n{3,}/g, '\n\n').trim();
    const mode   = recipe ? '📋 JSONスキーマ検出' : '📄 記事モード';

    // 画像候補収集（{url, adScore}[]）。adScore<5=コンテンツ→選択済み、>=5=広告疑い→非選択
    const imgCandidates = collectImages(recipe);
    // 状態管理: selected=保存する, adSuspect=広告疑いで最初は非選択
    const imgStates = imgCandidates.map(c => ({ url: c.url, selected: c.adScore < 5 }));

    // ノートブック一覧
    const notebooks = (cfg.get('notebooks', 'ストック') || 'ストック').split('\n').map(s => s.trim()).filter(Boolean);
    const defaultNb = cfg.get('default_notebook', 'ストック');
    const nbOptions = notebooks.map(nb =>
      `<option value="${nb}" ${nb === defaultNb ? 'selected' : ''}>${nb}</option>`
    ).join('');

    const overlay = document.createElement('div');
    overlay.id = 'mc-overlay';
    overlay.innerHTML = `
      <div id="mc-panel">
        <h2>📎 My Clips に保存</h2>

        <div class="mc-label">タイトル</div>
        <input class="mc-input" id="mc-title" type="text" value="${title.replace(/"/g, '&quot;')}">

        <div class="mc-label">フォルダ</div>
        <select class="mc-select" id="mc-nb">${nbOptions}</select>

        <div class="mc-label">タグ（カンマ区切り）</div>
        <input class="mc-input" id="mc-tags" type="text" value="${tags.join(', ')}">

        <div class="mc-label">メモ（任意）</div>
        <textarea class="mc-textarea" id="mc-memo" placeholder="追記メモ…"></textarea>

        <div style="margin-top:12px">
          <span class="mc-badge">${mode}</span>
          <span class="mc-badge">🔗 ${location.hostname}</span>
        </div>

        <div class="mc-label" id="mc-img-label">📷 画像を選択（タップで除外）</div>
        <div class="mc-img-grid" id="mc-img-grid"></div>
        <div class="mc-img-count" id="mc-img-count"></div>

        <div id="mc-status"></div>

        <div class="mc-footer">
          <button class="mc-btn-cancel" id="mc-cancel">キャンセル</button>
          <button class="mc-btn-save" id="mc-save">💾 保存</button>
        </div>
        <div style="text-align:right; margin-top:10px">
          <button onclick="" id="mc-open-settings"
            style="background:none;border:none;color:#6B6B72;font-size:12px;cursor:pointer">⚙️ 設定</button>
        </div>
      </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) removeOverlay(); });
    document.body.appendChild(overlay);

    // 画像グリッドの描画と更新
    function renderImgGrid() {
      const grid = document.getElementById('mc-img-grid');
      const countEl = document.getElementById('mc-img-count');
      if (!grid) return;
      if (imgStates.length === 0) {
        grid.innerHTML = '';
        document.getElementById('mc-img-label').style.display = 'none';
        countEl.textContent = '';
        return;
      }
      grid.innerHTML = imgStates.map((s, i) => `
        <div class="mc-img-item ${s.selected ? 'on' : 'off'}" data-i="${i}">
          <img src="${s.url}" alt="" loading="lazy">
          <div class="mc-img-chk">${s.selected ? '✓' : '✗'}</div>
        </div>`).join('');
      grid.querySelectorAll('.mc-img-item').forEach(el => {
        el.addEventListener('click', () => {
          const i = parseInt(el.dataset.i);
          imgStates[i].selected = !imgStates[i].selected;
          renderImgGrid();
        });
      });
      const n = imgStates.filter(s => s.selected).length;
      countEl.textContent = `${n} / ${imgStates.length} 枚を保存`;
    }
    renderImgGrid();

    document.getElementById('mc-cancel').onclick = removeOverlay;
    document.getElementById('mc-open-settings').onclick = showSettingsUI;

    // ステータス表示
    function setStatus(type, msg) {
      const el = document.getElementById('mc-status');
      if (!el) return;
      if (type === 'loading') {
        el.innerHTML = `<div class="mc-status"><div class="mc-spinner"></div>${msg.replace(/\n/g, '<br>')}</div>`;
      } else if (type === 'success') {
        el.innerHTML = `<div class="mc-status" style="color:#2A7A2A;font-weight:600">${msg.replace(/\n/g, '<br>')}</div>`;
        document.getElementById('mc-save').disabled = true;
        setTimeout(removeOverlay, 2500);
      } else if (type === 'error') {
        el.innerHTML = `<div class="mc-status" style="color:#c0392b">${msg}</div>`;
        document.getElementById('mc-save').disabled = false;
      }
    }

    document.getElementById('mc-save').onclick = async () => {
      const saveBtn = document.getElementById('mc-save');
      saveBtn.disabled = true;

      const tagsRaw = document.getElementById('mc-tags').value;
      const tagList = tagsRaw.split(/[,、]/).map(t => t.trim()).filter(Boolean);

      try {
        await saveNote({
          title:    document.getElementById('mc-title').value.trim() || title,
          notebook: document.getElementById('mc-nb').value,
          tags:     tagList,
          memo:     document.getElementById('mc-memo').value,
          _recipe:  recipe,
          _body:    body,
          selectedUrls: imgStates.filter(s => s.selected).map(s => s.url),
        }, setStatus);
      } catch (e) {
        setStatus('error', `⚠️ エラー: ${e.message || String(e)}`);
      }
    };
  }

  // ─── フローティングボタン注入 ─────────────────────────────
  function injectButton() {
    if (document.getElementById('mc-btn')) return;
    injectStyle();
    const btn = document.createElement('button');
    btn.id = 'mc-btn';
    btn.textContent = '📎';
    btn.title = 'My Clips に保存';
    btn.onclick = showClipperUI;
    // 長押し（0.7秒）で設定を開く
    let pressTimer = null;
    btn.addEventListener('touchstart', () => {
      pressTimer = setTimeout(() => { pressTimer = null; showSettingsUI(); }, 700);
    }, { passive: true });
    btn.addEventListener('touchend', () => {
      if (pressTimer) clearTimeout(pressTimer);
    });
    document.body.appendChild(btn);
  }

  // ─── 起動 ────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }

})();
