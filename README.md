# evernote

# 1. pipx を入れる（既にあればスキップ）
brew install pipx
pipx ensurepath

# 2. evernote-backup インストール
pipx install evernote-backup

# 3. 作業ディレクトリ作成
mkdir -p /workspaces/evernote/evernote-salvage && cd /workspaces/evernote/evernote-salvage

# 4. 初期化 + OAuth ログイン
# → ブラウザが自動で開き Evernote の認可画面に飛びます
# → 認可するとターミナルに "Successfully authenticated" と出る
evernote-backup init-db

# 5. 全データをローカルSQLiteへ同期
# → ノート数によって数分〜数十分かかる。進捗バーが出ます
evernote-backup sync

# 6. ENEXとして書き出し（1ノート1ファイル形式）
# --single-notes: ノートブック単位ではなくノート単位で出力
# --include-trash: ゴミ箱のノートも含める（不要なら外す）
# --add-guid: 各ノートにユニークID付与（後の重複排除に有用）
evernote-backup export --single-notes --include-trash --add-guid ./enex_out/

# 7. 確認
ls -la ./enex_out/ | head
find ./enex_out -name "*.enex" | wc -l   # 出力されたENEXファイル数

# 8. .enexファイルを.mdへ変換
pip3 install markdownify --user
python3 enex_to_markdown.py ./enex_out/ ./notes/

# 9. インデックス生成（初回 + notes更新のたびに実行）
python3 build_index.py

# 10. index.html と search-index.json と build_index.py を追加
git add notes/
git add index.html build_index.py search-index.json
git commit -m "Initial Commit"
git push