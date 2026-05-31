#!/usr/bin/env python3
"""
build_index.py
notes/ ディレクトリを走査して search-index.json を生成します。

Usage:
    python3 build_index.py [notes_dir] [output_file]

Default:
    python3 build_index.py ./notes ./search-index.json
"""

import sys
import json
import re
from pathlib import Path
from datetime import datetime, timezone


def parse_frontmatter(text: str):
    """YAML frontmatter を簡易パースして (meta_dict, body_str) を返す。"""
    if not text.startswith('---'):
        return {}, text

    end = text.find('\n---', 3)
    if end == -1:
        return {}, text

    fm_text = text[3:end].strip()
    body = text[end + 4:].strip()

    meta = {}
    for line in fm_text.split('\n'):
        if ':' not in line:
            continue
        key, _, val = line.partition(':')
        key = key.strip()
        val = val.strip().strip('"')

        if val.startswith('[') and val.endswith(']'):
            inner = val[1:-1]
            meta[key] = [x.strip().strip('"') for x in inner.split(',') if x.strip()]
        else:
            meta[key] = val

    return meta, body


def make_preview(body: str, length: int = 200) -> str:
    """Markdown 記法を除去してプレビューテキストを作成。"""
    text = re.sub(r'^#{1,6}\s+', '', body, flags=re.MULTILINE)  # headings
    text = re.sub(r'!\[.*?\]\(.*?\)', '', text)                  # images
    text = re.sub(r'\[.*?\]\(.*?\)', r'', text)                  # links
    text = re.sub(r'[*_`~>]', '', text)                          # emphasis
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:length]


def main():
    notes_dir = Path(sys.argv[1] if len(sys.argv) > 1 else './notes')
    output_file = Path(sys.argv[2] if len(sys.argv) > 2 else './search-index.json')

    if not notes_dir.exists():
        print(f'ERROR: {notes_dir} が見つかりません')
        sys.exit(1)

    notes = []
    note_files = sorted(notes_dir.rglob('note.md'))

    for note_md in note_files:
        try:
            text = note_md.read_text(encoding='utf-8')
            meta, body = parse_frontmatter(text)

            # リポルート（notes/の親）からの相対パス
            rel_path = str(note_md.relative_to(notes_dir.parent)).replace('\\', '/')
            note_dir_path = str(note_md.parent.relative_to(notes_dir.parent)).replace('\\', '/')

            # 画像ファイルを列挙（サイズ大きい順 → ロゴ・アイコン排除）
            images_dir = note_md.parent / 'images'
            image_files = []
            if images_dir.exists():
                candidates = [
                    img for img in images_dir.iterdir()
                    if img.suffix.lower() in ('.jpg', '.jpeg', '.png', '.gif', '.webp')
                ]
                # 10KB以上を優先。なければ全候補にフォールバック
                large = [img for img in candidates if img.stat().st_size >= 10_240]
                ranked = sorted(large or candidates,
                                key=lambda f: f.stat().st_size, reverse=True)
                image_files = [f'{note_dir_path}/images/{img.name}' for img in ranked]

            tags = meta.get('tags', [])
            if not isinstance(tags, list):
                tags = []

            notes.append({
                'id': rel_path,
                'title': meta.get('title', note_md.parent.name),
                'notebook': meta.get('notebook', note_md.parent.parent.name),
                'path': rel_path,
                'note_dir': note_dir_path,
                'created': meta.get('created', ''),
                'updated': meta.get('updated', ''),
                'tags': tags,
                'source_url': meta.get('source_url', ''),
                'guid': meta.get('guid', ''),
                'preview': make_preview(body),
                'has_images': bool(image_files),
                'first_image': image_files[0] if image_files else '',
            })

        except Exception as e:
            print(f'WARNING: {note_md} のパースに失敗: {e}')

    index = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'count': len(notes),
        'notes': notes,
    }

    output_file.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding='utf-8'
    )
    print(f'✅ {len(notes)} 件のノートをインデックス化 → {output_file}')


if __name__ == '__main__':
    main()