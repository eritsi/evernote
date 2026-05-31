#!/usr/bin/env python3
"""
enex_to_markdown.py
Evernote の .enex ファイルを Markdown + 画像フォルダ構造に変換します。

使い方:
    python enex_to_markdown.py <enex_dir_or_file> <output_dir>

例:
    # --single-notes で出力したフォルダ（ノートブック別サブディレクトリ）の場合
    python enex_to_markdown.py ./enex_out/ ./notes/

    # 単一ファイルの場合（ノートブック名はファイル名から取得）
    python enex_to_markdown.py ./recipes.enex ./notes/

出力構造:
    notes/
      {notebook}/
        {note-slug}/
          note.md        ← frontmatter + Markdown 本文
          images/        ← 添付画像（あれば）
            foo.jpg
"""

import sys
import os
import re
import hashlib
import base64
from pathlib import Path
from datetime import datetime
import unicodedata
from urllib.parse import quote as url_quote

try:
    from markdownify import markdownify as md_convert
    HAS_MARKDOWNIFY = True
except ImportError:
    HAS_MARKDOWNIFY = False
    print("WARNING: markdownify がありません。pip install markdownify を推奨。")

# DOCTYPE 宣言を含む XML を安全にパースするため lxml or 前処理を使う
try:
    from lxml import etree as lxml_etree
    HAS_LXML = True
except ImportError:
    HAS_LXML = False
    from xml.etree import ElementTree as ET


# ────────────────────────────────────────
# ユーティリティ
# ────────────────────────────────────────

def slugify(text: str, max_bytes: int = 80) -> str:
    """テキストをファイルシステム安全なスラグに変換。日本語はそのまま保持。"""
    text = text.strip()
    # ファイル名に使えない文字を置換
    text = re.sub(r'[\\/:*?"<>|]', '-', text)
    text = re.sub(r'\s+', '-', text)
    text = text.strip('-')
    # バイト長制限
    encoded = text.encode('utf-8')
    if len(encoded) > max_bytes:
        # 文字境界を壊さずに切る
        cut = encoded[:max_bytes]
        text = cut.decode('utf-8', errors='ignore').rstrip('-')
    return text or 'untitled'


def parse_en_date(s: str) -> str:
    """EvernoteのYYYYMMDDTHHMMSSZ形式をISO 8601に変換。"""
    if not s:
        return ''
    try:
        return datetime.strptime(s.strip(), '%Y%m%dT%H%M%SZ').strftime('%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        return s.strip()


def yaml_str(s: str) -> str:
    """YAML frontmatter 用に文字列をクォート。"""
    s = s.replace('"', '\\"')
    return f'"{s}"'


# ────────────────────────────────────────
# XML パース（DOCTYPE 対策）
# ────────────────────────────────────────

def strip_doctype(xml_text: str) -> str:
    """DOCTYPE 宣言を取り除く（ElementTree が DTD 解決を試みるため）。"""
    return re.sub(r'<!DOCTYPE[^>]*(?:>[^<]*<)?>', '', xml_text, flags=re.DOTALL)


def parse_xml_safe(path: Path):
    """ENEX ファイルを安全にパース。lxml があれば使う、なければ前処理して ET。"""
    raw = path.read_text(encoding='utf-8', errors='replace')
    if HAS_LXML:
        parser = lxml_etree.XMLParser(recover=True, resolve_entities=False, load_dtd=False)
        return lxml_etree.fromstring(raw.encode('utf-8'), parser=parser)
    else:
        cleaned = strip_doctype(raw)
        return ET.fromstring(cleaned)


def findtext_safe(el, tag: str, default: str = '') -> str:
    child = el.find(tag)
    if child is None:
        return default
    return (child.text or '').strip()


# ────────────────────────────────────────
# リソース（添付画像）処理
# ────────────────────────────────────────

MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
}


def process_resources(note_el):
    """
    リソースを処理して (hash→filename の dict, hash→bytes の dict) を返す。
    hash は ENML の en-media[@hash] と一致する MD5 16進数文字列。
    """
    resource_map = {}  # hash_hex → filename
    resource_data = {}  # hash_hex → bytes

    for res in note_el.findall('resource'):
        data_el = res.find('data')
        if data_el is None or not (data_el.text or '').strip():
            continue

        # base64 デコード
        b64 = re.sub(r'\s+', '', data_el.text)
        try:
            raw = base64.b64decode(b64)
        except Exception:
            continue

        # MD5 ハッシュ（ENML の hash 属性と一致させる）
        hash_hex = hashlib.md5(raw).hexdigest()

        # ファイル名を決定
        attrs = res.find('resource-attributes')
        fname = ''
        if attrs is not None:
            fname = findtext_safe(attrs, 'file-name')

        if not fname:
            mime = findtext_safe(res, 'mime', 'application/octet-stream')
            ext = MIME_TO_EXT.get(mime, '.bin')
            fname = hash_hex[:12] + ext

        # 同名ファイルが既にある場合はハッシュ8桁を付加して区別
        # 例: photo.jpg → photo-a1b2c3d4.jpg
        if fname in resource_map.values():
            import os as _os
            name, ext = _os.path.splitext(fname)
            fname = f'{name}-{hash_hex[:8]}{ext}'

        resource_map[hash_hex] = fname
        resource_data[hash_hex] = raw

    return resource_map, resource_data


# ────────────────────────────────────────
# ENML → Markdown 変換
# ────────────────────────────────────────

def enml_to_markdown(enml_text: str, resource_map: dict) -> str:
    """ENML (HTML 系 XML) を Markdown に変換。"""

    # en-media → Markdown 画像参照に置換
    def replace_en_media(m):
        full_tag = m.group(0)
        hash_match = re.search(r'hash=["\']([a-f0-9]+)["\']', full_tag)
        if hash_match:
            h = hash_match.group(1)
            if h in resource_map:
                fname = resource_map[h]
                return f'\n![{fname}](./images/{url_quote(fname)})\n'
        return ''

    text = re.sub(r'<en-media[^>]*/>', replace_en_media, enml_text, flags=re.DOTALL)
    text = re.sub(r'<en-media[^>]*></en-media>', replace_en_media, text, flags=re.DOTALL)

    # en-todo チェックボックス
    text = re.sub(r'<en-todo[^>]*checked=["\']true["\'][^>]*/>', '- [x] ', text)
    text = re.sub(r'<en-todo[^>]*/>', '- [ ] ', text)

    # en-note ラッパーを除去
    text = re.sub(r'</?en-note[^>]*>', '', text)

    # 内部 DOCTYPE/XML 宣言を除去
    text = re.sub(r'<\?xml[^?]*\?>', '', text)
    text = strip_doctype(text)

    if HAS_MARKDOWNIFY:
        result = md_convert(
            text,
            heading_style='ATX',
            bullets='-',
            newline_style='backslash',
        )
    else:
        # フォールバック：タグ除去のみ
        result = re.sub(r'<[^>]+>', '', text)

    # 余分な空行を整理
    result = re.sub(r'\n{3,}', '\n\n', result)
    return result.strip()


# ────────────────────────────────────────
# ノート1件の変換・書き出し
# ────────────────────────────────────────

def convert_note(note_el, output_base: Path, notebook_name: str, used_slugs: set):
    """1件のノートを変換して output_base/{notebook}/{slug}/ に書き出す。"""
    title = findtext_safe(note_el, 'title', 'Untitled')
    created = parse_en_date(findtext_safe(note_el, 'created'))
    updated = parse_en_date(findtext_safe(note_el, 'updated'))
    tags = [t.text.strip() for t in note_el.findall('tag') if t.text]
    guid = findtext_safe(note_el, 'guid')

    note_attrs_el = note_el.find('note-attributes')
    source_url = ''
    if note_attrs_el is not None:
        source_url = findtext_safe(note_attrs_el, 'source-url')

    # リソース処理
    resource_map, resource_data = process_resources(note_el)

    # ENML コンテンツ取得
    content_el = note_el.find('content')
    enml_text = (content_el.text or '') if content_el is not None else ''
    markdown_body = enml_to_markdown(enml_text, resource_map)

    # スラグ（重複回避）
    base_slug = slugify(title)
    slug = base_slug
    counter = 1
    while (notebook_name, slug) in used_slugs:
        slug = f'{base_slug}-{counter}'
        counter += 1
    used_slugs.add((notebook_name, slug))

    # ディレクトリ作成
    note_dir = output_base / notebook_name / slug
    note_dir.mkdir(parents=True, exist_ok=True)

    # 画像書き出し
    if resource_data:
        img_dir = note_dir / 'images'
        img_dir.mkdir(exist_ok=True)
        for hash_hex, data in resource_data.items():
            fname = resource_map[hash_hex]
            (img_dir / fname).write_bytes(data)

    # Frontmatter + Markdown 書き出し
    fm = ['---']
    fm.append(f'title: {yaml_str(title)}')
    if created:
        fm.append(f'created: {created}')
    if updated:
        fm.append(f'updated: {updated}')
    fm.append(f'notebook: {yaml_str(notebook_name)}')
    if tags:
        tags_yaml = '[' + ', '.join(yaml_str(t) for t in tags) + ']'
        fm.append(f'tags: {tags_yaml}')
    else:
        fm.append('tags: []')
    if source_url:
        fm.append(f'source_url: {yaml_str(source_url)}')
    if guid:
        fm.append(f'guid: {guid}')
    fm.append('---')
    fm.append('')
    fm.append(f'# {title}')
    fm.append('')
    fm.append(markdown_body)

    (note_dir / 'note.md').write_text('\n'.join(fm) + '\n', encoding='utf-8')
    return title


# ────────────────────────────────────────
# ENEX ファイル1つを処理
# ────────────────────────────────────────

def process_enex(enex_path: Path, output_base: Path, notebook_name: str, used_slugs: set) -> int:
    try:
        root = parse_xml_safe(enex_path)
    except Exception as e:
        print(f'  [ERROR] XML パース失敗 {enex_path.name}: {e}')
        return 0

    # lxml と ET でタグ名の扱いが少し異なる場合があるので両対応
    notes = root.findall('note') or root.findall('{*}note')
    count = 0
    for note_el in notes:
        try:
            title = convert_note(note_el, output_base, notebook_name, used_slugs)
            print(f'    ✓ {title}')
            count += 1
        except Exception as e:
            import traceback
            t = findtext_safe(note_el, 'title', '(unknown)')
            print(f'  [ERROR] ノート処理失敗 "{t}": {e}')
            traceback.print_exc()
    return count


# ────────────────────────────────────────
# メイン
# ────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    src = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)

    used_slugs: set = set()
    total = 0

    if src.is_file() and src.suffix == '.enex':
        # 単一ファイル
        notebook_name = src.stem
        print(f'📓 {notebook_name}')
        count = process_enex(src, output_dir, notebook_name, used_slugs)
        print(f'   → {count} ノート変換')
        total += count

    elif src.is_dir():
        # ディレクトリ内を再帰探索
        # パターン A: enex_out/{notebook}/{note}.enex  （--single-notes の典型出力）
        # パターン B: enex_out/{notebook}.enex         （ノートブック単位の出力）
        # パターン C: enex_out/{note}.enex             （フラット）

        enex_files = sorted(src.rglob('*.enex'))
        if not enex_files:
            print(f'[ERROR] .enex ファイルが見つかりません: {src}')
            sys.exit(1)

        for enex_file in enex_files:
            relative = enex_file.relative_to(src)
            parts = relative.parts
            if len(parts) >= 2:
                # パターン A: サブディレクトリ名をノートブック名として使う
                notebook_name = parts[0]
            else:
                # パターン B/C: ファイル名（拡張子なし）をノートブック名として使う
                notebook_name = enex_file.stem

            print(f'📓 {notebook_name} / {enex_file.name}')
            count = process_enex(enex_file, output_dir, notebook_name, used_slugs)
            print(f'   → {count} ノート変換')
            total += count

    else:
        print(f'[ERROR] 指定パスが見つかりません: {src}')
        sys.exit(1)

    print(f'\n✅ 完了: 合計 {total} ノートを {output_dir} に変換しました')


if __name__ == '__main__':
    main()